use super::*;
use crate::workspace::paths::normalize_dir;
use std::io::BufReader;

#[test]
fn discovers_configs_and_substitutes_variables() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".vscode")).unwrap();
    std::fs::write(
        d.path().join(".vscode/launch.json"),
        r#"{
          // comment
          "version": "0.2.0",
          "configurations": [
            { "name": "Run file", "type": "python", "request": "launch", "program": "${file}", "cwd": "${workspaceFolder}", "args": ["--x", "${fileBasenameNoExtension}"] },
            { "name": "Bad", "type": "python", "request": "launch", "env": { "A": "${env:SECRET}" } },
            { "type": "python" },
          ]
        }"#,
    )
    .unwrap();
    let roots = vec![normalize_dir(d.path()).unwrap()];
    let (configs, issues) = discover(&roots);
    assert_eq!(configs.len(), 2);
    assert_eq!(issues.len(), 1);
    let folder = roots[0].path.clone();
    let file = folder.join("src").join("app.py");
    let vars = FileVars { file: Some(file.clone()), relative: Some("src/app.py".into()) };
    let r = substitute(&configs[0].raw, &folder, &vars).unwrap();
    assert_eq!(r["program"], file.display().to_string());
    assert_eq!(r["args"][1], "app");
    assert_eq!(r["cwd"], folder.display().to_string());
    assert!(substitute(&configs[1].raw, &folder, &vars).unwrap_err().contains("${env:SECRET}"));
    assert!(substitute(&configs[0].raw, &folder, &FileVars::default()).unwrap_err().contains("needs an open file"));
    let a = fingerprint("w", &configs[0].id, &r);
    let mut r2 = r.clone();
    r2["args"][1] = "other".into();
    assert_ne!(a, fingerprint("w", &configs[0].id, &r2));
}

#[test]
fn user_adapters_need_absolute_existing_programs() {
    let d = tempfile::tempdir().unwrap();
    let exe = d.path().join("adapter.exe");
    std::fs::write(&exe, "x").unwrap();
    let a = user_adapters(&[
        format!("mydbg|{}|--dap --x", exe.display()),
        "bad type!|C:\\x.exe|".into(),
        "rel|adapter.exe|".into(),
    ]);
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].types, vec!["mydbg"]);
    assert_eq!(a[0].args, vec!["--dap", "--x"]);
}

const FAKE_ADAPTER: &str = r#"
let buf = Buffer.alloc(0);
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write(`Content-Length: ${b.length}\r\n\r\n`); process.stdout.write(b); };
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    const n = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, i).toString())[1]);
    if (buf.length < i + 4 + n) return;
    const msg = JSON.parse(buf.slice(i + 4, i + 4 + n).toString()); buf = buf.slice(i + 4 + n);
    if (msg.command === 'initialize') send({ type: 'response', request_seq: msg.seq, success: true, command: 'initialize', body: { supportsConfigurationDoneRequest: true } });
    if (msg.command === 'disconnect') { send({ type: 'response', request_seq: msg.seq, success: true, command: 'disconnect' }); process.exit(0); }
  }
});
"#;

#[test]
fn speaks_dap_over_stdio() {
    let Some(node) = crate::toolchains::which("node") else { return };
    let d = tempfile::tempdir().unwrap();
    let script = d.path().join("adapter.js");
    std::fs::write(&script, FAKE_ADAPTER).unwrap();
    let adapter = Adapter {
        id: "fake".into(),
        name: "Fake".into(),
        types: vec!["fake".into()],
        program: node.display().to_string(),
        args: vec![script.display().to_string()],
        source: "user",
    };
    let (mut p, stdout, _err) = spawn(&adapter, d.path(), "main").unwrap();
    p.send(r#"{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"fake"}}"#).unwrap();
    let mut r = BufReader::new(stdout);
    let msg: Value = serde_json::from_slice(&framing::read_message(&mut r).unwrap().unwrap()).unwrap();
    assert_eq!(msg["command"], "initialize");
    assert_eq!(msg["body"]["supportsConfigurationDoneRequest"], true);
    p.send(r#"{"seq":2,"type":"request","command":"disconnect"}"#).unwrap();
    let msg: Value = serde_json::from_slice(&framing::read_message(&mut r).unwrap().unwrap()).unwrap();
    assert_eq!(msg["command"], "disconnect");
    assert!(framing::read_message(&mut r).unwrap().is_none());
}
