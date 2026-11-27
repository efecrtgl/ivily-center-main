//! Text document I/O for the editor: encoding and line-ending detection, size limits, binary
//! detection, hash-checked atomic saves and crash-recovery drafts.
//!
//! Documents are addressed by [`DocRef`]: a file inside the window's workspace, or an opaque token
//! for a file outside it that the user picked in a native dialog (the webview never names paths).

pub mod drafts;

use crate::error::{AppError, AppResult};
use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

/// Files above this size are refused (the editor is not a hex viewer / log tailer).
pub const MAX_OPEN_BYTES: u64 = 64 * 1024 * 1024;
const BINARY_PROBE: usize = 8000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Encoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    /// Fallback for non-UTF-8 text without a BOM. Round-trips every byte.
    #[serde(rename = "windows-1252")]
    Windows1252,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    /// Content with `\n` line endings.
    pub content: String,
    pub encoding: Encoding,
    /// Dominant line ending of the file (LF if none).
    pub eol: Eol,
    /// The file mixes LF and CRLF (saving normalizes to `eol`).
    pub mixed_eol: bool,
    /// SHA-256 of the bytes on disk (used to detect external changes on save).
    pub hash: String,
    pub size: u64,
    pub readonly: bool,
    pub modified: i64,
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

/// Decode bytes into text. Returns `None` for binary content.
pub fn decode(bytes: &[u8]) -> Option<(String, Encoding)> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(rest).ok().map(|s| (s.to_string(), Encoding::Utf8Bom));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, bad) = UTF_16LE.decode(bytes);
        return (!bad).then(|| (s.into_owned(), Encoding::Utf16Le));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, bad) = UTF_16BE.decode(bytes);
        return (!bad).then(|| (s.into_owned(), Encoding::Utf16Be));
    }
    if looks_binary(bytes) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Some((s.to_string(), Encoding::Utf8)),
        Err(_) => {
            let (s, _) = WINDOWS_1252.decode_without_bom_handling(bytes);
            Some((s.into_owned(), Encoding::Windows1252))
        }
    }
}

/// Normalize to `\n` and report the dominant ending.
pub fn normalize_eol(text: &str) -> (String, Eol, bool) {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let out = text.replace("\r\n", "\n");
    let eol = if crlf > lf { Eol::Crlf } else { Eol::Lf };
    (out, eol, crlf > 0 && lf > 0)
}

pub fn encode(text: &str, encoding: Encoding, eol: Eol) -> AppResult<Vec<u8>> {
    let text = match eol {
        Eol::Lf => text.replace("\r\n", "\n"),
        Eol::Crlf => text.replace("\r\n", "\n").replace('\n', "\r\n"),
    };
    Ok(match encoding {
        Encoding::Utf8 => text.into_bytes(),
        Encoding::Utf8Bom => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(text.as_bytes());
            v
        }
        Encoding::Utf16Le => {
            let mut v = vec![0xFF, 0xFE];
            for u in text.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        }
        Encoding::Utf16Be => {
            let mut v = vec![0xFE, 0xFF];
            for u in text.encode_utf16() {
                v.extend_from_slice(&u.to_be_bytes());
            }
            v
        }
        Encoding::Windows1252 => {
            let (bytes, _, unmappable) = WINDOWS_1252.encode(&text);
            if unmappable {
                return Err(AppError::validation(
                    "unencodable",
                    "the text contains characters that cannot be saved as Windows-1252; change the encoding to UTF-8",
                ));
            }
            bytes.into_owned()
        }
    })
}

fn millis(t: std::io::Result<std::time::SystemTime>) -> i64 {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn read(path: &Path) -> AppResult<TextDocument> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        return Err(AppError::validation("is_directory", "this is a folder"));
    }
    if meta.len() > MAX_OPEN_BYTES {
        return Err(AppError::validation(
            "too_large",
            format!("the file is larger than {} MB", MAX_OPEN_BYTES / 1024 / 1024),
        ));
    }
    let bytes = std::fs::read(path)?;
    let (text, encoding) =
        decode(&bytes).ok_or_else(|| AppError::validation("binary", "the file appears to be binary"))?;
    let (content, eol, mixed_eol) = normalize_eol(&text);
    Ok(TextDocument {
        content,
        encoding,
        eol,
        mixed_eol,
        hash: hash(&bytes),
        size: meta.len(),
        readonly: meta.permissions().readonly(),
        modified: millis(meta.modified()),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub hash: String,
    pub size: u64,
    pub modified: i64,
}

/// Save atomically. `expected_hash`: the file must still have this content (unless `None`, which
/// the UI only sends after the user chose to overwrite a changed file, or for a new file).
pub fn write(
    path: &Path,
    content: &str,
    encoding: Encoding,
    eol: Eol,
    expected_hash: Option<&str>,
    create: bool,
) -> AppResult<SaveResult> {
    let bytes = encode(content, encoding, eol)?;
    match std::fs::read(path) {
        Ok(current) => {
            if create {
                return Err(AppError::Conflict(format!("{} already exists", path.display())));
            }
            if let Some(h) = expected_hash {
                if hash(&current) != h {
                    return Err(AppError::Conflict("the file was changed on disk since it was opened".into()));
                }
            }
            if std::fs::metadata(path)?.permissions().readonly() {
                return Err(AppError::PermissionDenied("the file is read-only".into()));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create && expected_hash.is_some() {
                return Err(AppError::Conflict("the file was deleted or moved on disk".into()));
            }
        }
        Err(e) => return Err(e.into()),
    }
    let dir = path.parent().ok_or_else(|| AppError::validation("invalid_path", "missing folder"))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.ivily-save-{}.tmp", crate::core::now_ms()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    let meta = std::fs::metadata(path)?;
    Ok(SaveResult { hash: hash(&bytes), size: meta.len(), modified: millis(meta.modified()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_encodings_and_round_trips() {
        for (enc, eol) in [
            (Encoding::Utf8, Eol::Lf),
            (Encoding::Utf8Bom, Eol::Crlf),
            (Encoding::Utf16Le, Eol::Crlf),
            (Encoding::Utf16Be, Eol::Lf),
            (Encoding::Windows1252, Eol::Lf),
        ] {
            let text = "héllo\nwörld\n";
            let bytes = encode(text, enc, eol).unwrap();
            let (decoded, detected) = decode(&bytes).unwrap();
            assert_eq!(detected, enc);
            let (norm, e, mixed) = normalize_eol(&decoded);
            assert_eq!(norm, text);
            assert_eq!(e, eol);
            assert!(!mixed);
        }
    }

    #[test]
    fn binary_and_mixed_eol() {
        assert!(decode(b"PNG\0\0\x01binary").is_none());
        let (_, eol, mixed) = normalize_eol("a\r\nb\r\nc\n");
        assert_eq!((eol, mixed), (Eol::Crlf, true));
        assert!(encode("€ ok", Encoding::Windows1252, Eol::Lf).is_ok());
        assert!(encode("emoji 😀", Encoding::Windows1252, Eol::Lf).is_err());
    }

    #[test]
    fn save_detects_external_changes_and_never_clobbers() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.txt");
        std::fs::write(&p, "one\r\ntwo\r\n").unwrap();
        let doc = read(&p).unwrap();
        assert_eq!(doc.content, "one\ntwo\n");
        assert_eq!(doc.eol, Eol::Crlf);
        let r = write(&p, "one\ntwo\nthree\n", doc.encoding, doc.eol, Some(&doc.hash), false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "one\r\ntwo\r\nthree\r\n");
        std::fs::write(&p, "changed elsewhere").unwrap();
        assert!(matches!(write(&p, "mine", doc.encoding, doc.eol, Some(&r.hash), false), Err(AppError::Conflict(_))));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "changed elsewhere");
        // Explicit overwrite (user confirmed).
        write(&p, "mine", Encoding::Utf8, Eol::Lf, None, false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "mine");
        // New file must not exist.
        assert!(write(&p, "x", Encoding::Utf8, Eol::Lf, None, true).is_err());
        write(&d.path().join("new.txt"), "x", Encoding::Utf8, Eol::Lf, None, true).unwrap();
        // Deleted while open → conflict, not silent re-creation.
        std::fs::remove_file(&p).unwrap();
        assert!(write(&p, "x", Encoding::Utf8, Eol::Lf, Some("abc"), false).is_err());
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 1, "no temp files left");
    }

    #[test]
    fn refuses_binary_and_folders() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("b.bin"), [0u8, 1, 2, 3]).unwrap();
        assert!(matches!(read(&d.path().join("b.bin")), Err(AppError::Validation { code: "binary", .. })));
        assert!(read(d.path()).is_err());
    }
}
