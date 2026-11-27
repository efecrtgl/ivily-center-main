//! Best-effort removal of secrets from log lines before they are stored or displayed.
//!
//! This is a defence-in-depth layer: code must still avoid logging secrets in the first place.

use regex::Regex;
use std::sync::LazyLock;

const MASK: &str = "«redacted»";

static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        // Authorization: Bearer xxx / Basic xxx
        (r"(?i)\b(authorization\s*[:=]\s*)(bearer|basic|token)\s+[^\s,;]+", "${1}${2} «redacted»"),
        // URL user-info: scheme://user:pass@host
        (r"(?i)\b([a-z][a-z0-9+.\-]*://)[^\s/@:]+:[^\s/@]+@", "${1}«redacted»@"),
        // key=value / key: value for secret-looking names (env vars, config files)
        (
            r#"(?i)\b([a-z0-9_.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|client[_\-]?secret|credential)[a-z0-9_.\-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)"#,
            "${1}${2}«redacted»",
        ),
        // CLI flags: --token abc, -password abc
        (
            r#"(?i)(\s|^)(--?[a-z\-]*(?:password|passwd|secret|token|api-?key|credential)[a-z\-]*)\s+("[^"]*"|'[^']*'|[^\s\-][^\s]*)"#,
            "${1}${2} «redacted»",
        ),
        // Well-known token formats
        (r"\bgh[pousr]_[A-Za-z0-9]{20,}\b", MASK),
        (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", MASK),
        (r"\bglpat-[A-Za-z0-9_\-]{20,}\b", MASK),
        (r"\bsk-[A-Za-z0-9_\-]{20,}\b", MASK),
        (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b", MASK),
        (r"\bAKIA[0-9A-Z]{16}\b", MASK),
        (r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b", MASK),
        (r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)", MASK),
    ]
    .into_iter()
    .map(|(p, r)| (Regex::new(p).expect("valid redaction regex"), r))
    .collect()
});

pub fn redact(input: &str) -> String {
    let mut out = input.to_string();
    for (re, rep) in RULES.iter() {
        if re.is_match(&out) {
            out = re.replace_all(&out, *rep).into_owned();
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    fn assert_hidden(input: &str, secret: &str) {
        let out = redact(input);
        assert!(!out.contains(secret), "secret leaked: {input} -> {out}");
        assert!(out.contains("«redacted»"), "no mask in: {out}");
    }

    #[test]
    fn hides_common_secret_shapes() {
        assert_hidden("Authorization: Bearer abc.def.ghi", "abc.def.ghi");
        assert_hidden("cloning https://user:hunter2@github.com/x/y", "hunter2");
        assert_hidden("DB_PASSWORD=s3cr3t npm run dev", "s3cr3t");
        assert_hidden("api_key: \"zzz top\"", "zzz top");
        assert_hidden("--token abcdef123", "abcdef123");
        assert_hidden(concat!("push with gh", "p_0123456789abcdefghijABCDEFGHIJ"), "0123456789abcdefghij");
        assert_hidden(concat!("key AKIA", "ABCDEFGHIJKLMNOP"), "ABCDEFGHIJKLMNOP");
        assert_hidden("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----", "MIIE");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        for s in [
            "Compiling ivily-center v0.0.1",
            "theme changed to pixel-dark",
            "port 3000 is in use",
            "tokenizer ok",
            "password reset failed",
            "secret santa",
        ] {
            assert_eq!(redact(s), s);
        }
    }
}
