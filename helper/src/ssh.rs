//! One SSH session per page connection, reused for every command and upload.
//! Based on the session code in the Companion Rust prototype (companion-rs/src/device.rs).

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use ssh2::{ErrorCode, ExtendedData, Session};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a read may block before we send a keepalive. sysupgrade can be quiet for a while.
const READ_TIMEOUT_MS: u32 = 15_000;
const MAX_DOWNLOAD: u64 = 128 * 1024 * 1024;
const LIBSSH2_ERROR_TIMEOUT: i32 = -9;

pub struct Device {
    session: Session,
}

pub struct ExecOutcome {
    pub code: i32,
    /// The connection dropped before the command finished, e.g. the camera rebooted after flashing.
    pub disconnected: bool,
}

impl Device {
    pub fn connect(host: &str, port: u16, user: &str, password: &str) -> Result<Self> {
        let addr = (host, port)
            .to_socket_addrs()
            .with_context(|| format!("could not resolve {host}"))?
            .next()
            .ok_or_else(|| anyhow!("no address for {host}"))?;
        let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).with_context(|| format!("could not reach {host}:{port}"))?;
        let mut session = Session::new()?;
        session.set_timeout(CONNECT_TIMEOUT.as_millis() as u32);
        session.set_tcp_stream(tcp);
        session.handshake().context("SSH handshake failed")?;
        session.userauth_password(user, password).context("login failed, check the password")?;
        if !session.authenticated() {
            bail!("login failed, check the password");
        }
        session.set_keepalive(true, 10);
        Ok(Self { session })
    }

    /// Runs a command, passing stdout and stderr (merged) to `on_output` as it arrives.
    pub fn exec_streaming(&self, command: &str, mut on_output: impl FnMut(&str) -> Result<()>) -> Result<ExecOutcome> {
        let mut channel = self.session.channel_session()?;
        channel.handle_extended_data(ExtendedData::Merge)?;
        channel.exec(command)?;
        self.session.set_timeout(READ_TIMEOUT_MS);

        let mut buf = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            match channel.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Only forward complete UTF-8; keep a split character for the next read.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(s) => s.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                        pending.drain(..valid);
                        on_output(&text)?;
                    }
                }
                Err(e) if is_timeout(&e) => {
                    // Quiet command: check the link is still up.
                    if self.session.keepalive_send().is_err() {
                        return Ok(ExecOutcome { code: -1, disconnected: true });
                    }
                }
                Err(_) => return Ok(ExecOutcome { code: -1, disconnected: true }),
            }
        }
        if !pending.is_empty() {
            on_output(&String::from_utf8_lossy(&pending))?;
        }
        if channel.wait_close().is_err() {
            return Ok(ExecOutcome { code: -1, disconnected: true });
        }
        Ok(ExecOutcome { code: channel.exit_status().unwrap_or(-1), disconnected: false })
    }

    /// Sends a file with the legacy SCP protocol (`scp -t` on the camera). Cameras have no SFTP server.
    pub fn scp_upload(&self, remote_path: &str, data: &[u8], mut on_progress: impl FnMut(u64, u64) -> Result<()>) -> Result<()> {
        self.session.set_timeout(60_000);
        let total = data.len() as u64;
        let mut channel = self
            .session
            .scp_send(Path::new(remote_path), 0o644, total, None)
            .with_context(|| format!("could not start SCP upload to {remote_path}"))?;
        let step = (total / 100).max(64 * 1024) as usize;
        let mut sent = 0usize;
        let mut last_report = 0usize;
        for chunk in data.chunks(32 * 1024) {
            channel.write_all(chunk).context("upload interrupted")?;
            sent += chunk.len();
            if sent - last_report >= step || sent == data.len() {
                on_progress(sent as u64, total)?;
                last_report = sent;
            }
        }
        channel.send_eof()?;
        channel.wait_eof()?;
        channel.close()?;
        channel.wait_close()?;
        Ok(())
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    if e.kind() == std::io::ErrorKind::TimedOut {
        return true;
    }
    e.get_ref()
        .and_then(|inner| inner.downcast_ref::<ssh2::Error>())
        .map(|se| se.code() == ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT))
        .unwrap_or(false)
}

/// Only GitHub release downloads, so a page can't use the helper to fetch arbitrary URLs.
pub fn is_release_asset_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    // owner/repo/releases/download/tag/file
    parts.len() == 6
        && parts[2] == "releases"
        && parts[3] == "download"
        && parts.iter().all(|p| !p.is_empty() && *p != ".." && !p.contains(['?', '#', '@', '\\']))
}

pub fn download_release_asset(url: &str) -> Result<Vec<u8>> {
    if !is_release_asset_url(url) {
        bail!("only GitHub release downloads are allowed");
    }
    let agent = ureq::AgentBuilder::new().try_proxy_from_env(true).timeout(Duration::from_secs(300)).build();
    let resp = agent.get(url).call().with_context(|| format!("download failed: {url}"))?;
    let mut data = Vec::new();
    resp.into_reader().take(MAX_DOWNLOAD + 1).read_to_end(&mut data)?;
    if data.len() as u64 > MAX_DOWNLOAD {
        bail!("download larger than {} MB", MAX_DOWNLOAD / 1024 / 1024);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_urls() {
        assert!(is_release_asset_url("https://github.com/OpenIPC/builder/releases/download/latest/ssc338q_fpv_openipc-thinker-aio-nor.tgz"));
        assert!(!is_release_asset_url("https://github.com/OpenIPC/builder/archive/main.zip"));
        assert!(!is_release_asset_url("https://github.com.evil.example/a/b/releases/download/t/f"));
        assert!(!is_release_asset_url("http://github.com/a/b/releases/download/t/f"));
        assert!(!is_release_asset_url("https://github.com/a/b/releases/download/t/f?x=1"));
        assert!(!is_release_asset_url("https://github.com/a/b/releases/download/t/../f"));
        assert!(!is_release_asset_url("https://169.254.169.254/latest"));
    }
}
