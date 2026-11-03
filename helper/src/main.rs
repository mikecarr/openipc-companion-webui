//! openipc-helper: a small local SSH bridge for the OpenIPC web flasher.
//!
//! It listens on 127.0.0.1 only and accepts WebSocket connections only from the flasher page's
//! origin. It knows nothing about OpenIPC: the page sends `connect`, `exec`, `upload` and `close`
//! and decides everything else, so the flashing logic can change on GitHub without a new helper.

mod protocol;
mod ssh;

use std::net::{TcpListener, TcpStream};
use std::thread;

use anyhow::{Context, Result};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;
use tungstenite::{accept_hdr, Message};

use protocol::{Reply, Request as Req};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 47811;
const DEFAULT_ORIGIN: &str = "https://mikecarr.github.io";

#[derive(Clone)]
struct Config {
    port: u16,
    origins: Vec<String>,
    dev: bool,
}

fn parse_args() -> Result<Config> {
    let mut cfg = Config { port: DEFAULT_PORT, origins: vec![DEFAULT_ORIGIN.into()], dev: false };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => cfg.port = args.next().context("--port needs a value")?.parse()?,
            "--allow-origin" => cfg.origins.push(args.next().context("--allow-origin needs a value")?),
            "--dev" => cfg.dev = true,
            "--version" => {
                println!("openipc-helper {VERSION}");
                std::process::exit(0);
            }
            "-h" | "--help" => {
                println!("openipc-helper {VERSION}\n\nUsage: openipc-helper [--port N] [--allow-origin URL]... [--dev]\n\n  --dev  also accept http://localhost and http://127.0.0.1 pages (for local development)");
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument {other}"),
        }
    }
    Ok(cfg)
}

/// Exact match against the allowed origins; `--dev` adds any localhost port.
pub fn origin_allowed(origin: Option<&str>, origins: &[String], dev: bool) -> bool {
    let Some(origin) = origin else { return false };
    if origins.iter().any(|o| o == origin) {
        return true;
    }
    if dev {
        for prefix in ["http://localhost", "http://127.0.0.1"] {
            if let Some(rest) = origin.strip_prefix(prefix) {
                if rest.is_empty() || (rest.starts_with(':') && rest[1..].chars().all(|c| c.is_ascii_digit())) {
                    return true;
                }
            }
        }
    }
    false
}

fn main() -> Result<()> {
    let cfg = parse_args()?;
    let listener = TcpListener::bind(("127.0.0.1", cfg.port)).with_context(|| format!("could not listen on 127.0.0.1:{}", cfg.port))?;
    println!("openipc-helper {VERSION} listening on ws://127.0.0.1:{}", cfg.port);
    println!("accepting pages from: {}{}", cfg.origins.join(", "), if cfg.dev { ", localhost (dev)" } else { "" });
    for stream in listener.incoming().flatten() {
        let cfg = cfg.clone();
        thread::spawn(move || {
            if let Err(e) = serve(stream, &cfg) {
                eprintln!("connection closed: {e:#}");
            }
        });
    }
    Ok(())
}

fn serve(stream: TcpStream, cfg: &Config) -> Result<()> {
    let (origins, dev) = (cfg.origins.clone(), cfg.dev);
    let check = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
        if origin_allowed(origin, &origins, dev) {
            Ok(resp)
        } else {
            eprintln!("refused page from origin {:?}", origin);
            let mut err = ErrorResponse::new(Some("origin not allowed".into()));
            *err.status_mut() = StatusCode::FORBIDDEN;
            Err(err)
        }
    };
    let mut ws = accept_hdr(stream, check)?;
    let mut device: Option<ssh::Device> = None;

    loop {
        let msg = match ws.read() {
            Ok(m) => m,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let req: Req = match serde_json::from_str(&text) {
            Ok(r) => r,
            Err(e) => {
                send(&mut ws, &Reply::error(0, format!("bad request: {e}")))?;
                continue;
            }
        };
        let id = req.id();
        if let Err(e) = handle(req, &mut device, &mut ws) {
            send(&mut ws, &Reply::error(id, format!("{e:#}")))?;
        }
    }
}

type Ws = tungstenite::WebSocket<TcpStream>;

fn send(ws: &mut Ws, reply: &Reply) -> Result<()> {
    ws.send(Message::Text(serde_json::to_string(reply)?))?;
    Ok(())
}

fn handle(req: Req, device: &mut Option<ssh::Device>, ws: &mut Ws) -> Result<()> {
    match req {
        Req::Hello { id } => send(ws, &Reply::Hello { id, version: VERSION.into() }),
        Req::Connect { id, host, port, user, password } => {
            *device = None;
            let d = ssh::Device::connect(&host, port.unwrap_or(22), user.as_deref().unwrap_or("root"), &password)?;
            *device = Some(d);
            send(ws, &Reply::ok(id))
        }
        Req::Exec { id, cmd } => {
            let d = device.as_ref().context("not connected")?;
            let outcome = d.exec_streaming(&cmd, |chunk| send(ws, &Reply::Output { id, text: chunk.to_string() }))?;
            if outcome.disconnected {
                *device = None;
            }
            send(ws, &Reply::Exit { id, code: outcome.code, disconnected: outcome.disconnected })
        }
        Req::Upload { id, remote_path, url, size } => {
            let d = device.as_ref().context("not connected")?;
            let data = match (url, size) {
                (Some(url), _) => {
                    send(ws, &Reply::Status { id, text: format!("downloading {url}") })?;
                    ssh::download_release_asset(&url)?
                }
                (None, Some(size)) => {
                    // The page sends the file as the next binary message.
                    let data = loop {
                        match ws.read()? {
                            Message::Binary(b) => break b,
                            Message::Ping(_) | Message::Pong(_) => continue,
                            _ => anyhow::bail!("expected the file as a binary message"),
                        }
                    };
                    anyhow::ensure!(data.len() as u64 == size, "file size mismatch: expected {size}, got {}", data.len());
                    data.to_vec()
                }
                (None, None) => anyhow::bail!("upload needs url or size"),
            };
            d.scp_upload(&remote_path, &data, |sent, total| {
                send(ws, &Reply::Progress { id, sent, total })
            })?;
            send(ws, &Reply::ok(id))
        }
        Req::Close { id } => {
            *device = None;
            send(ws, &Reply::ok(id))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::origin_allowed;

    #[test]
    fn origins() {
        let allowed = vec!["https://mikecarr.github.io".to_string()];
        assert!(origin_allowed(Some("https://mikecarr.github.io"), &allowed, false));
        assert!(!origin_allowed(Some("https://evil.example"), &allowed, false));
        assert!(!origin_allowed(Some("https://mikecarr.github.io.evil.example"), &allowed, false));
        assert!(!origin_allowed(None, &allowed, false));
        assert!(!origin_allowed(Some("http://localhost:8000"), &allowed, false));
        assert!(origin_allowed(Some("http://localhost:8000"), &allowed, true));
        assert!(origin_allowed(Some("http://127.0.0.1"), &allowed, true));
        assert!(!origin_allowed(Some("http://localhost.evil.example"), &allowed, true));
        assert!(!origin_allowed(Some("http://localhost:80@evil"), &allowed, true));
    }
}
