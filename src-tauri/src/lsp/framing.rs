//! LSP / DAP base protocol framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`.

use std::io::{BufRead, Write};

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub fn write_message(w: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(body)
}

/// Read one message body. `Ok(None)` at end of stream.
pub fn read_message(r: &mut impl BufRead) -> std::io::Result<Option<Vec<u8>>> {
    let mut len: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let l = line.trim_end_matches(['\r', '\n']);
        if l.is_empty() {
            if len.is_some() {
                break;
            }
            continue; // tolerate stray blank lines between messages
        }
        if let Some((name, value)) = l.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                len = value.trim().parse().ok();
            }
        }
        if line.len() > 8192 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "header line too long"));
        }
    }
    let n = len.unwrap_or(0);
    if n > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too large"));
    }
    let mut body = vec![0; n];
    r.read_exact(&mut body)?;
    Ok(Some(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_multiple_messages() {
        let mut buf = Vec::new();
        write_message(&mut buf, br#"{"a":1}"#).unwrap();
        write_message(&mut buf, "{\"é\":2}".as_bytes()).unwrap();
        buf.extend_from_slice(
            b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}",
        );
        let mut r = std::io::BufReader::new(&buf[..]);
        assert_eq!(read_message(&mut r).unwrap().unwrap(), br#"{"a":1}"#);
        assert_eq!(read_message(&mut r).unwrap().unwrap(), "{\"é\":2}".as_bytes());
        assert_eq!(read_message(&mut r).unwrap().unwrap(), b"{}");
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    #[test]
    fn rejects_oversized_messages() {
        let data = format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1);
        let mut r = std::io::BufReader::new(data.as_bytes());
        assert!(read_message(&mut r).is_err());
    }
}
