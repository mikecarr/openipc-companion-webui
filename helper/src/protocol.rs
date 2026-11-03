//! JSON messages between the page and the helper. Every request carries an `id`; every reply
//! echoes it. `exec` and `upload` send several replies (output/progress) before the final one.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Request {
    Hello { id: u64 },
    Connect { id: u64, host: String, port: Option<u16>, user: Option<String>, password: String },
    Exec { id: u64, cmd: String },
    /// Either `url` (a GitHub release asset the helper downloads) or `size` (the page sends the
    /// bytes as the next binary message).
    Upload {
        id: u64,
        #[serde(rename = "remotePath")]
        remote_path: String,
        url: Option<String>,
        size: Option<u64>,
    },
    Close { id: u64 },
}

impl Request {
    pub fn id(&self) -> u64 {
        match self {
            Request::Hello { id }
            | Request::Connect { id, .. }
            | Request::Exec { id, .. }
            | Request::Upload { id, .. }
            | Request::Close { id } => *id,
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Reply {
    Hello { id: u64, version: String },
    Ok { id: u64 },
    Error { id: u64, message: String },
    Output { id: u64, text: String },
    Status { id: u64, text: String },
    Progress { id: u64, sent: u64, total: u64 },
    Exit { id: u64, code: i32, disconnected: bool },
}

impl Reply {
    pub fn ok(id: u64) -> Self {
        Reply::Ok { id }
    }
    pub fn error(id: u64, message: String) -> Self {
        Reply::Error { id, message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_requests() {
        let r: Request = serde_json::from_str(r#"{"id":3,"op":"upload","remotePath":"/tmp/a.tgz","size":10}"#).unwrap();
        assert_eq!(r, Request::Upload { id: 3, remote_path: "/tmp/a.tgz".into(), url: None, size: Some(10) });
        let r: Request = serde_json::from_str(r#"{"id":1,"op":"connect","host":"10.0.0.5","password":"x"}"#).unwrap();
        assert_eq!(r.id(), 1);
        assert!(serde_json::from_str::<Request>(r#"{"id":1,"op":"shell"}"#).is_err());
    }

    #[test]
    fn serialises_replies() {
        let s = serde_json::to_string(&Reply::Exit { id: 2, code: 0, disconnected: true }).unwrap();
        assert_eq!(s, r#"{"type":"exit","id":2,"code":0,"disconnected":true}"#);
    }
}
