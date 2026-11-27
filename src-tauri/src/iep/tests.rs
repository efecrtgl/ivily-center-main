use super::*;

#[test]
fn version_compatibility_follows_semver_0x_rules() {
    assert!(compatible("0.1.0") && compatible("0.1.7"));
    assert!(!compatible("0.2.0") && !compatible("1.0.0") && !compatible("x"));
}

#[test]
fn requests_use_the_provider_dialect_and_allowlist() {
    let opt = provider("ivily-optimizer").unwrap();
    let (args, body) = encode_request(opt, "health", &Value::Null).unwrap();
    assert_eq!(args, vec!["--iep", "request"]);
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["protocol"], "iep");
    assert_eq!(v["version"], CLIENT_VERSION);
    assert_eq!(v["method"], "health");
    assert!(v.get("params").is_none(), "empty params are omitted");
    assert!(encode_request(opt, "operation.request", &Value::Null).is_err(), "not allowlisted");

    let env = provider("ivily-envora").unwrap();
    let (args, body) = encode_request(env, "envora.health", &json!({})).unwrap();
    assert_eq!(args, vec!["--iep"]);
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["iep"], 1);
    assert_eq!(v["method"], "envora.health");
}

#[test]
fn decodes_both_dialects() {
    let opt = provider("ivily-optimizer").unwrap();
    assert_eq!(decode_response(opt, &json!({ "ok": true, "result": { "a": 1 } })).unwrap()["a"], 1);
    let e = decode_response(opt, &json!({ "ok": false, "error": { "code": "unknown_method", "message": "x" } }))
        .unwrap_err();
    assert!(e.to_string().contains("unknown_method"));
    let env = provider("ivily-envora").unwrap();
    assert_eq!(decode_response(env, &json!({ "iep": 1, "id": "c", "result": [1] })).unwrap(), json!([1]));
    assert!(decode_response(env, &json!({ "iep": 1, "id": "c", "error": { "code": "not_granted", "message": "" } }))
        .is_err());
}

#[test]
fn locate_prefers_valid_overrides() {
    let d = tempfile::tempdir().unwrap();
    let exe = d.path().join("x.exe");
    std::fs::write(&exe, "x").unwrap();
    let opt = provider("ivily-optimizer").unwrap();
    assert_eq!(locate(opt, &[format!("ivily-optimizer|{}", exe.display())]), Some(exe));
    assert_eq!(locate(opt, &["ivily-optimizer|relative.exe".into()]), None);
}

#[test]
fn binaries_without_matching_version_info_are_refused() {
    // A file that is not a PE with version info.
    let d = tempfile::tempdir().unwrap();
    let fake = d.path().join("ivily-optimizer.exe");
    std::fs::write(&fake, "not a program").unwrap();
    let opt = provider("ivily-optimizer").unwrap();
    assert!(check_binary(opt, &fake).is_err());
    let s = status(opt, &[format!("ivily-optimizer|{}", fake.display())]);
    assert_eq!(s.status, "incompatible");
    // A real Windows executable with a different product name.
    let cmd = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join("cmd.exe");
    if cmd.is_file() {
        let info = version::read(&cmd).expect("cmd.exe has version info");
        assert!(!info.product_name.is_empty());
        assert!(check_binary(opt, &cmd).unwrap_err().contains("not Ivily Optimizer"));
    }
}

#[test]
fn center_server_validates_requests() {
    let ok = |raw: &str| server::handle(raw.as_bytes());
    let (v, good) = ok(r#"{"protocol":"iep","version":"0.1.0","id":"t-1","method":"capabilities"}"#);
    assert!(good, "{v}");
    assert_eq!(v["ok"], true);
    assert_eq!(v["result"][0]["id"], "app.identity");
    for (raw, code) in [
        (r#"{"protocol":"iep","version":"0.1.0","id":"t","method":"capabilities","extra":1}"#, "invalid_request"),
        (r#"{"protocol":"x","version":"0.1.0","id":"t","method":"health"}"#, "unsupported_protocol"),
        (r#"{"protocol":"iep","version":"0.2.0","id":"t","method":"health"}"#, "incompatible_version"),
        (r#"{"protocol":"iep","version":"0.1.0","id":"bad id","method":"health"}"#, "invalid_id"),
        (r#"{"protocol":"iep","version":"0.1.0","id":"t","method":"shell"}"#, "unknown_method"),
        (r#"{"protocol":"iep","version":"0.1.0","id":"t","method":"health","params":{"a":1}}"#, "invalid_params"),
    ] {
        let (v, good) = ok(raw);
        assert!(!good);
        assert_eq!(v["error"]["code"], code, "{raw}");
    }
    let (v, _) = server::handle(&vec![b' '; 70 * 1024]);
    assert_eq!(v["error"]["code"], "too_large");
    let d = server::describe();
    assert_eq!(d["protocol"]["version"], "0.1.0");
    assert_eq!(d["transport"]["backgroundService"], false);
}

/// Real sibling binaries, when they are built next to this repository (developer machine only).
#[test]
fn talks_to_locally_built_modules_when_present() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    for p in PROVIDERS {
        let exe = root.join(p.product).join("src-tauri").join("target").join("release").join(p.exe);
        if !exe.is_file() || check_binary(p, &exe).is_err() {
            continue;
        }
        let s = status(p, &[format!("{}|{}", p.product, exe.display())]);
        eprintln!("real module {}: {} {:?} {:?}", p.product, s.status, s.version, s.message);
        assert!(matches!(s.status, "ok" | "degraded" | "disabled"), "{}: {:?} {:?}", p.product, s.status, s.message);
        if p.dialect == Dialect::Iep01 {
            let h = request(p, &exe, "health", &Value::Null).unwrap();
            assert!(h.get("status").is_some(), "{h}");
        }
    }
}

/// An installed build older than the IEP minimum is refused without being started.
#[test]
fn old_installed_builds_are_not_started() {
    for p in PROVIDERS {
        let Some(path) = locate(p, &[]) else { continue };
        if let Some(info) = version::read(&path) {
            if info.version < p.min_version {
                let s = status(p, &[]);
                eprintln!("installed {}: {} {:?}", p.product, s.status, s.message);
                assert_eq!(s.status, "incompatible");
            }
        }
    }
}
