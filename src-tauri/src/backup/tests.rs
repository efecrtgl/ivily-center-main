use super::*;

fn setup() -> (tempfile::TempDir, Connection) {
    let d = tempfile::tempdir().unwrap();
    let mut conn = Connection::open(d.path().join("center.db")).unwrap();
    crate::db::migrate(&mut conn, crate::db::MIGRATIONS, None).unwrap();
    crate::app_state::set(&conn, "k", &"original").unwrap();
    std::fs::create_dir_all(d.path().join("notes")).unwrap();
    std::fs::write(d.path().join("notes/ws_1.md"), "# notes").unwrap();
    std::fs::create_dir_all(d.path().join("extensions/acme.sea")).unwrap();
    std::fs::write(d.path().join("extensions/acme.sea/ivily-extension.json"), "{}").unwrap();
    std::fs::write(d.path().join("unrelated.txt"), "not backed up").unwrap();
    (d, conn)
}

#[test]
fn civil_dates() {
    assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
    assert_eq!(civil(1_795_812_891), (2026, 11, 27, 20, 54, 51));
    assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
}

#[test]
fn safe_entries() {
    assert!(safe_entry("notes/a.md"));
    for bad in ["../x", "/x", "C:/x", "a\\b", "", "a/../b"] {
        assert!(!safe_entry(bad), "{bad}");
    }
}

#[test]
fn create_verify_list_and_retention() {
    let (d, conn) = setup();
    let p = create(&conn, d.path(), "manual").unwrap();
    let m = verify(&p).unwrap();
    let paths: Vec<_> = m.files.iter().map(|f| f.path.as_str()).collect();
    assert!(
        paths.contains(&"center.db")
            && paths.contains(&"notes/ws_1.md")
            && paths.contains(&"extensions/acme.sea/ivily-extension.json")
    );
    assert!(!paths.iter().any(|p| p.contains("unrelated")), "only Ivily data is included");
    assert_eq!(m.schema_version, crate::db::latest_version(crate::db::MIGRATIONS));
    for _ in 0..3 {
        std::thread::sleep(std::time::Duration::from_millis(1100));
        create(&conn, d.path(), "automatic").unwrap();
    }
    assert_eq!(list(d.path()).len(), 4);
    let removed = apply_retention(d.path(), 2);
    assert_eq!(removed.len(), 1);
    let left = list(d.path());
    assert_eq!(
        left.iter().filter(|b| b.manifest.as_ref().unwrap().kind == "manual").count(),
        1,
        "manual backups are kept"
    );
    assert!(resolve(d.path(), "../center.db").is_err());
    assert!(resolve(d.path(), &left[0].name).is_ok());
}

#[test]
fn damaged_archives_are_rejected() {
    let (d, conn) = setup();
    let p = create(&conn, d.path(), "manual").unwrap();
    // Rewrite the archive with a tampered note but the original manifest.
    let m = read_manifest(&p).unwrap();
    let bad = d.path().join("bad.zip");
    {
        let mut src = zip::ZipArchive::new(std::fs::File::open(&p).unwrap()).unwrap();
        let mut w = zip::ZipWriter::new(std::fs::File::create(&bad).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("manifest.json", o).unwrap();
        w.write_all(&serde_json::to_vec(&m).unwrap()).unwrap();
        for f in &m.files {
            w.start_file(f.path.as_str(), o).unwrap();
            if f.path == "notes/ws_1.md" {
                w.write_all(b"# tampered").unwrap();
            } else {
                std::io::copy(&mut src.by_name(&f.path).unwrap(), &mut w).unwrap();
            }
        }
        w.finish().unwrap();
    }
    let e = verify(&bad).unwrap_err().to_string();
    assert!(e.contains("damaged"), "{e}");
    std::fs::write(d.path().join("junk.zip"), b"not a zip").unwrap();
    assert!(verify(&d.path().join("junk.zip")).is_err());
}

#[test]
fn staged_restore_is_applied_before_the_database_opens() {
    let (d, conn) = setup();
    let p = create(&conn, d.path(), "manual").unwrap();
    crate::app_state::set(&conn, "k", &"changed later").unwrap();
    std::fs::write(d.path().join("notes/ws_1.md"), "# newer notes").unwrap();
    stage_restore(d.path(), &p).unwrap();
    drop(conn);
    let msg = apply_pending(d.path()).unwrap().unwrap();
    assert!(msg.contains("previous data kept"));
    let conn = Connection::open(d.path().join("center.db")).unwrap();
    let v: Option<String> = crate::app_state::get(&conn, "k").unwrap();
    assert_eq!(v.as_deref(), Some("original"));
    assert_eq!(std::fs::read_to_string(d.path().join("notes/ws_1.md")).unwrap(), "# notes");
    assert!(std::fs::read_dir(d.path())
        .unwrap()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with("replaced-by-restore-")));
    assert!(apply_pending(d.path()).is_none(), "applied once");
    assert!(d.path().join("unrelated.txt").exists());
}

#[test]
fn import_copies_verified_archives() {
    let (d, conn) = setup();
    let p = create(&conn, d.path(), "manual").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let copy = outside.path().join("my-backup.zip");
    std::fs::copy(&p, &copy).unwrap();
    let name = import(d.path(), &copy).unwrap();
    assert!(name.starts_with("ivily-center-imported-"));
    assert!(resolve(d.path(), &name).is_ok());
}
