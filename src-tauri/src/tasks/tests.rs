use super::*;
use crate::workspace::paths::normalize_dir;

fn root(d: &Path) -> Vec<NormalizedPath> {
    vec![normalize_dir(d).unwrap()]
}

#[test]
fn jsonc_comments_and_trailing_commas() {
    let v = jsonc::parse("{ // c\n \"a\": [1, 2, /* x */ ], \"s\": \"http://x // not a comment\", }").unwrap();
    assert_eq!(v["a"], serde_json::json!([1, 2]));
    assert_eq!(v["s"], "http://x // not a comment");
    assert!(jsonc::parse("{ a: 1 }").is_err());
}

#[test]
fn discovers_workspace_npm_and_cargo_tasks() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".ivily")).unwrap();
    std::fs::create_dir_all(d.path().join("sub")).unwrap();
    std::fs::write(
        d.path().join(".ivily/tasks.json"),
        r#"{ "version": 1, "tasks": [
            { "label": "hello", "command": "echo", "args": ["a b"], "options": { "cwd": "${workspaceFolder}/sub" }, "group": { "kind": "build" }, "problemMatcher": "$rustc" },
            { "label": "all", "dependsOn": ["hello", "npm: build"] },
            { "label": "bad var", "command": "echo ${file}" },
            { "label": "escape", "command": "echo", "options": { "cwd": ".." } },
            { "label": "npm: build", "type": "shell", "command": "echo override" },
        ] }"#,
    )
    .unwrap();
    std::fs::write(
        d.path().join("package.json"),
        r#"{ "scripts": { "build": "vite build", "test": "vitest", "x & calc": "evil" } }"#,
    )
    .unwrap();
    std::fs::write(d.path().join("Cargo.toml"), "[package]").unwrap();
    let (tasks, issues) = discover(&root(d.path()));
    assert!(issues.is_empty(), "{issues:?}");
    let get = |l: &str| tasks.iter().find(|t| t.label == l).unwrap_or_else(|| panic!("{l} missing: {tasks:?}"));
    let hello = get("hello");
    assert_eq!(hello.exec, Some(Exec::Shell { line: "echo \"a b\"".into() }));
    assert_eq!(hello.cwd, "sub");
    assert_eq!(hello.group.as_deref(), Some("build"));
    assert_eq!(hello.problem_matchers, vec!["rustc"]);
    assert!(get("bad var").error.as_deref().unwrap().contains("${file}"));
    assert!(get("escape").error.as_deref().unwrap().contains("outside"));
    // Workspace task overrides the detected npm script with the same label.
    assert_eq!(get("npm: build").source, "ivily");
    assert_eq!(
        get("npm: test").exec,
        Some(Exec::Process { program: "npm".into(), args: vec!["run".into(), "test".into()] })
    );
    assert!(!tasks.iter().any(|t| t.label.contains("calc")), "unsafe npm script names are skipped");
    assert_eq!(get("cargo test").group.as_deref(), Some("test"));
    // Dependencies come first.
    let order: Vec<_> = plan(&tasks, &get("all").id).unwrap().iter().map(|t| t.label.clone()).collect();
    assert_eq!(order, vec!["hello", "npm: build", "all"]);
}

#[test]
fn dependency_cycles_and_unknown_tasks_are_errors() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".vscode")).unwrap();
    std::fs::write(
        d.path().join(".vscode/tasks.json"),
        r#"{ "tasks": [ { "label": "a", "dependsOn": "b" }, { "label": "b", "dependsOn": ["a"] }, { "label": "c", "dependsOn": "zzz" } ] }"#,
    )
    .unwrap();
    let (tasks, _) = discover(&root(d.path()));
    assert!(plan(&tasks, "vscode:0:a").is_err());
    assert!(matches!(plan(&tasks, "vscode:0:c"), Err(AppError::NotFound(_))));
}

#[test]
fn fingerprint_changes_with_the_command() {
    let d = tempfile::tempdir().unwrap();
    let mk = |line: &str| Task {
        id: "ivily:0:x".into(),
        label: "x".into(),
        source: "ivily",
        root: 0,
        exec: Some(Exec::Shell { line: line.into() }),
        cwd: String::new(),
        group: None,
        depends_on: vec![],
        depends_order: "sequence".into(),
        problem_matchers: vec![],
        detail: None,
        error: None,
    };
    assert_eq!(mk("a").fingerprint("w"), mk("a").fingerprint("w"));
    assert_ne!(mk("a").fingerprint("w"), mk("b").fingerprint("w"));
    assert_ne!(mk("a").fingerprint("w"), mk("a").fingerprint("v"));
    let _ = d;
}

#[test]
fn shell_commands() {
    let (exe, args) = command_for(&Exec::Shell { line: "echo hi".into() }, Shell::Cmd).unwrap();
    assert!(exe.ends_with("cmd.exe"));
    assert_eq!(args, vec!["/d", "/c", "echo", "hi"]);
    assert!(command_for(&Exec::Shell { line: "echo \"x\"".into() }, Shell::Cmd).is_err());
    let (exe, args) = command_for(&Exec::Shell { line: "Write-Output 'é'".into() }, Shell::PowerShell).unwrap();
    assert!(exe.to_string_lossy().to_lowercase().ends_with("powershell.exe"));
    assert_eq!(args[2], "-EncodedCommand");
    let decoded = base64::engine::general_purpose::STANDARD.decode(&args[3]).unwrap();
    let u16s: Vec<u16> = decoded.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    assert!(String::from_utf16(&u16s).unwrap().starts_with("Write-Output 'é'\n"));
}

#[test]
fn powershell_task_propagates_exit_codes() {
    let ps = system32().join(r"WindowsPowerShell\v1.0\powershell.exe");
    if !ps.exists() {
        return;
    }
    let run = |line: &str| {
        let (exe, args) = command_for(&Exec::Shell { line: line.into() }, Shell::PowerShell).unwrap();
        std::process::Command::new(exe).args(args).output().unwrap()
    };
    let ok = run("Write-Output \"a b\"");
    assert!(ok.status.success());
    assert_eq!(String::from_utf8_lossy(&ok.stdout).trim(), "a b");
    assert_eq!(run("cmd /c exit 3").status.code(), Some(3));
    assert_eq!(run("Get-Item C:\\does\\not\\exist").status.code(), Some(1));
}
