//! Center's own IEP 0.1 provider: `ivily-center.exe --iep describe` and
//! `ivily-center.exe --iep request` (one request on stdin). Read-only: no window, no single
//! instance, the database is never created, migrated or written.

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};

pub const PROTOCOL_VERSION: &str = "0.1.0";
const MAX_REQUEST: usize = 64 * 1024;
const METHODS: [&str; 3] = ["describe", "health", "capabilities"];

fn capabilities() -> Value {
    json!([
        { "id": "app.identity", "version": "1", "access": "read", "status": "available", "description": "Application identity, version and protocol version." },
        { "id": "app.capabilities", "version": "1", "access": "read", "status": "available", "description": "List of supported capabilities." },
        { "id": "app.health", "version": "1", "access": "read", "status": "available", "description": "Data folder and database state." },
    ])
}

/// Database state, read-only (never creates or migrates).
pub fn health() -> Value {
    let dir = crate::core::data_dir();
    let db = dir.join(crate::db::DB_FILE);
    let expected = crate::db::latest_version(crate::db::MIGRATIONS);
    let (database, schema) = if !db.is_file() {
        ("missing", Value::Null)
    } else {
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        match rusqlite::Connection::open_with_flags(&db, flags).and_then(|c| {
            c.pragma_update(None, "query_only", true)?;
            c.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
        }) {
            Ok(v) if v == expected => ("ok", json!(v)),
            Ok(v) if v < expected => ("needs-migration", json!(v)),
            Ok(v) => ("newer-schema", json!(v)),
            Err(_) => ("unreadable", Value::Null),
        }
    };
    let status = if matches!(database, "newer-schema" | "unreadable") { "degraded" } else { "ok" };
    json!({ "status": status, "dataDirExists": dir.is_dir(), "database": database, "schemaVersion": schema, "expectedSchemaVersion": expected })
}

pub fn describe() -> Value {
    json!({
        "protocol": { "name": "iep", "version": PROTOCOL_VERSION, "minCompatible": PROTOCOL_VERSION },
        "app": {
            "id": "com.efecrtgl.ivilycenter",
            "product": "ivily-center",
            "name": "Ivily Center",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": "windows",
            "repository": "https://github.com/efecrtgl/ivily-center-main",
        },
        "transport": { "kind": "cli", "describe": ["--iep", "describe"], "request": ["--iep", "request"], "backgroundService": false },
        "capabilities": capabilities(),
        "health": health(),
        "generatedAt": crate::core::now_ms() / 1000,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: String,
    version: String,
    id: String,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

fn reply(id: Option<&str>, result: Result<Value, (&str, String)>) -> Value {
    let base = json!({ "protocol": "iep", "version": PROTOCOL_VERSION, "id": id });
    let mut v = base;
    match result {
        Ok(r) => {
            v["ok"] = json!(true);
            v["result"] = r;
        }
        Err((code, message)) => {
            v["ok"] = json!(false);
            v["error"] = json!({ "code": code, "message": message });
        }
    }
    v
}

/// Handle one raw request. Never panics; every problem is an error response.
pub fn handle(raw: &[u8]) -> (Value, bool) {
    if raw.len() > MAX_REQUEST {
        return (reply(None, Err(("too_large", "the request is larger than 64 KB".into()))), false);
    }
    let req: Request = match serde_json::from_slice(raw) {
        Ok(r) => r,
        Err(e) => return (reply(None, Err(("invalid_request", e.to_string()))), false),
    };
    if req.protocol != "iep" {
        return (reply(None, Err(("unsupported_protocol", "protocol must be \"iep\"".into()))), false);
    }
    let id_ok = (1..=64).contains(&req.id.len())
        && req.id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !id_ok {
        return (
            reply(None, Err(("invalid_id", "id must be 1-64 characters of letters, digits, - _ .".into()))),
            false,
        );
    }
    let id = Some(req.id.as_str());
    if !super::compatible(&req.version) {
        return (
            reply(id, Err(("incompatible_version", format!("Ivily Center speaks IEP {PROTOCOL_VERSION}")))),
            false,
        );
    }
    if !METHODS.contains(&req.method.as_str()) {
        return (reply(id, Err(("unknown_method", format!("unknown method '{}'", req.method)))), false);
    }
    if req.params.as_ref().is_some_and(|p| !p.is_null() && !p.as_object().is_some_and(|o| o.is_empty())) {
        return (reply(id, Err(("invalid_params", "these methods take no parameters".into()))), false);
    }
    let result = match req.method.as_str() {
        "describe" => describe(),
        "health" => health(),
        _ => capabilities(),
    };
    (reply(id, Ok(result)), true)
}

/// If the process was started with `--iep`, answer and return the exit code.
pub fn maybe_run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--iep") {
        return None;
    }
    let mut out = std::io::stdout();
    let (value, code) = match args.get(1).map(String::as_str) {
        Some("describe") if args.len() == 2 => (describe(), 0),
        Some("request") if args.len() == 2 => {
            let mut buf = Vec::new();
            let _ = std::io::stdin().take(MAX_REQUEST as u64 + 1).read_to_end(&mut buf);
            let (v, ok) = handle(&buf);
            (v, if ok { 0 } else { 1 })
        }
        _ => (reply(None, Err(("usage", "usage: ivily-center --iep describe | --iep request".into()))), 2),
    };
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
    Some(code)
}
