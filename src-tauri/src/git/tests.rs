use super::*;

fn repo() -> Option<(Git, tempfile::TempDir)> {
    let git = Git::locate()?;
    let d = tempfile::tempdir().unwrap();
    git.ok(d.path(), &["init", "-q", "-b", "main"]).unwrap();
    git.ok(d.path(), &["config", "user.name", "Ivily Test"]).unwrap();
    git.ok(d.path(), &["config", "user.email", "test@example.invalid"]).unwrap();
    git.ok(d.path(), &["config", "commit.gpgsign", "false"]).unwrap();
    // Independent of the machine's global autocrlf setting.
    git.ok(d.path(), &["config", "core.autocrlf", "false"]).unwrap();
    Some((git, d))
}

#[test]
fn status_stage_commit_log() {
    let Some((git, d)) = repo() else { return };
    let r = d.path();
    std::fs::write(r.join("a.txt"), "one\n").unwrap();
    std::fs::create_dir(r.join("dir with space")).unwrap();
    std::fs::write(r.join("dir with space/ü.txt"), "x\n").unwrap();
    let st = status(&git, r).unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert!(st.head.is_none(), "no commit yet");
    let untracked: Vec<_> = st.files.iter().filter(|f| f.untracked).map(|f| f.path.as_str()).collect();
    assert!(untracked.contains(&"a.txt"));
    assert!(untracked.contains(&"dir with space/ü.txt"), "{untracked:?}");

    stage(&git, r, &["a.txt".into(), "dir with space/ü.txt".into()]).unwrap();
    unstage(&git, r, &["dir with space/ü.txt".into()]).unwrap(); // before the first commit
    let st = status(&git, r).unwrap();
    assert_eq!(st.files.iter().find(|f| f.path == "a.txt").unwrap().index, 'A');
    assert!(st.files.iter().find(|f| f.path.ends_with("ü.txt")).unwrap().untracked);

    let short = commit(&git, r, "first commit\n\nbody", false, false).unwrap();
    assert!(!short.is_empty());
    assert!(commit(&git, r, "  ", false, false).is_err());
    let log = log(&git, r, None, None, 0, 10).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].subject, "first commit");
    assert_eq!(log[0].author, "Ivily Test");
    assert_eq!(commit_files(&git, r, &log[0].sha).unwrap(), vec![("A".into(), "a.txt".into(), None)]);
    assert_eq!(show(&git, r, "HEAD", "a.txt").unwrap().as_deref(), Some("one\n"));
    assert_eq!(show(&git, r, "HEAD", "missing.txt").unwrap(), None);

    // Modify, discard (tracked files only).
    std::fs::write(r.join("a.txt"), "changed\n").unwrap();
    assert_eq!(status(&git, r).unwrap().files.iter().find(|f| f.path == "a.txt").unwrap().worktree, 'M');
    discard(&git, r, &["a.txt".into()]).unwrap();
    assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\n");
    assert!(r.join("dir with space/ü.txt").exists(), "untracked files are never deleted by discard");
}

#[test]
fn branches_merge_conflict_and_stages() {
    let Some((git, d)) = repo() else { return };
    let r = d.path();
    std::fs::write(r.join("f.txt"), "base\n").unwrap();
    stage(&git, r, &["f.txt".into()]).unwrap();
    commit(&git, r, "base", false, false).unwrap();
    check_ref_name(&git, r, "feature/x", true).unwrap();
    assert!(check_ref_name(&git, r, "-bad", true).is_err());
    assert!(check_ref_name(&git, r, "bad..name", true).is_err());
    git.ok(r, &["switch", "-c", "feature/x"]).unwrap();
    std::fs::write(r.join("f.txt"), "theirs\n").unwrap();
    commit(&git, r, "theirs", false, true).unwrap();
    git.ok(r, &["switch", "main"]).unwrap();
    std::fs::write(r.join("f.txt"), "ours\n").unwrap();
    commit(&git, r, "ours", false, true).unwrap();
    let b = branches(&git, r).unwrap();
    assert!(b.iter().any(|x| x.name == "main" && x.current));
    assert!(b.iter().any(|x| x.name == "feature/x" && !x.current));

    let o = git.run(r, &["merge", "feature/x"]).unwrap();
    assert_ne!(o.code, 0);
    let st = status(&git, r).unwrap();
    assert_eq!(st.operation, Some("merge"));
    let f = st.files.iter().find(|f| f.path == "f.txt").unwrap();
    assert!(f.conflicted);
    assert_eq!(show(&git, r, ":1", "f.txt").unwrap().as_deref(), Some("base\n"));
    assert_eq!(show(&git, r, ":2", "f.txt").unwrap().as_deref(), Some("ours\n"));
    assert_eq!(show(&git, r, ":3", "f.txt").unwrap().as_deref(), Some("theirs\n"));
    git.ok(r, &["merge", "--abort"]).unwrap();
    assert_eq!(status(&git, r).unwrap().operation, None);
}

#[test]
fn stash_round_trip() {
    let Some((git, d)) = repo() else { return };
    let r = d.path();
    std::fs::write(r.join("f.txt"), "a\n").unwrap();
    stage(&git, r, &["f.txt".into()]).unwrap();
    commit(&git, r, "c", false, false).unwrap();
    std::fs::write(r.join("f.txt"), "b\n").unwrap();
    git.ok(r, &["stash", "push", "-m", "wip"]).unwrap();
    let s = stashes(&git, r).unwrap();
    assert_eq!(s.len(), 1);
    assert_eq!(s[0].name, "stash@{0}");
    assert!(s[0].message.contains("wip"));
    check_stash(&s[0].name).unwrap();
    assert!(check_stash("stash@{0}; rm").is_err());
    git.ok(r, &["stash", "pop", &s[0].name]).unwrap();
    assert_eq!(std::fs::read_to_string(r.join("f.txt")).unwrap(), "b\n");
}

#[test]
fn validation() {
    for ok in ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@host/x.git"] {
        assert!(check_remote_url(ok).is_ok(), "{ok}");
    }
    for bad in ["--upload-pack=calc", "ext::sh -c touch", "file:///c:/x", "https://a b", ""] {
        assert!(check_remote_url(bad).is_err(), "{bad}");
    }
    assert!(check_remote_name("origin").is_ok());
    assert!(check_remote_name("-x").is_err());
    assert!(check_sha("abc123").is_ok());
    assert!(check_sha("HEAD;rm").is_err());
    assert!(validate_paths(&["../x".into()]).is_err());
    assert!(validate_paths(&[]).is_err());
}

#[test]
fn parses_status_records() {
    let out = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 a a src/a.rs\0\
2 R. N... 100644 100644 100644 a a R100 new.rs\0old.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? new file.txt\0";
    let st = parse::parse_status(out);
    assert_eq!((st.ahead, st.behind), (2, 1));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(st.files.len(), 4);
    assert_eq!(st.files[1].orig.as_deref(), Some("old.rs"));
    assert!(st.files[2].conflicted);
    assert_eq!(st.files[3].path, "new file.txt");
}
