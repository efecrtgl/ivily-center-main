//! Declarative extensions.
//!
//! An extension is a folder with `ivily-extension.json` and JSON assets it references. Extensions
//! contain **no code**: they contribute themes, icon packs, snippets, keyboard shortcuts for
//! existing commands and file associations. Installing copies only the manifest and the referenced
//! JSON files (validated paths and sizes) into `%LOCALAPPDATA%\IvilyCenter\extensions\<id>`.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

pub const MANIFEST: &str = "ivily-extension.json";
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_FILE: u64 = 1024 * 1024;
const MAX_TOTAL: u64 = 10 * 1024 * 1024;
const MAX_FILES: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetContribution {
    pub language: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingContribution {
    pub key: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageContribution {
    pub id: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub themes: Vec<String>,
    #[serde(default)]
    pub icon_packs: Vec<String>,
    #[serde(default)]
    pub snippets: Vec<SnippetContribution>,
    #[serde(default)]
    pub keybindings: Vec<KeybindingContribution>,
    #[serde(default)]
    pub languages: Vec<LanguageContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub contributes: Contributes,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::validation("invalid_extension", msg.into())
}

/// `publisher.name`, lower case.
pub fn valid_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let ok = |p: Option<&str>| {
        p.is_some_and(|s| {
            (1..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// A relative `a/b.json` path inside the extension (no `..`, no absolute, JSON only).
pub fn valid_asset(rel: &str) -> bool {
    let p = Path::new(rel);
    rel.len() <= 200
        && rel.to_ascii_lowercase().ends_with(".json")
        && !rel.contains(['\\', ':'])
        && p.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Parse and validate a manifest.
pub fn parse_manifest(text: &str) -> AppResult<Manifest> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| bad(format!("invalid manifest: {e}")))?;
    if !valid_id(&m.id) {
        return Err(bad("the id must look like publisher.name (lower case letters, digits, -)"));
    }
    if m.name.trim().is_empty()
        || m.name.len() > 80
        || m.version.is_empty()
        || m.version.len() > 40
        || m.description.len() > 500
        || m.publisher.len() > 80
    {
        return Err(bad("name, version, publisher or description is missing or too long"));
    }
    let c = &m.contributes;
    let assets = c.themes.iter().chain(c.icon_packs.iter()).chain(c.snippets.iter().map(|s| &s.path));
    for a in assets {
        if !valid_asset(a) {
            return Err(bad(format!("invalid asset path '{a}'")));
        }
    }
    if c.keybindings.len() > 200
        || c.languages.len() > 50
        || c.snippets.len() > 50
        || c.themes.len() > 50
        || c.icon_packs.len() > 10
    {
        return Err(bad("too many contributions"));
    }
    for k in &c.keybindings {
        if k.key.len() > 40
            || k.command.len() > 100
            || k.command.starts_with('-')
            || k.when.as_ref().is_some_and(|w| w.len() > 200)
        {
            return Err(bad("invalid keybinding contribution"));
        }
    }
    for l in &c.languages {
        if l.id.len() > 40
            || l.extensions.len() > 20
            || l.extensions.iter().any(|e| {
                e.is_empty()
                    || e.len() > 20
                    || !e
                        .trim_start_matches('.')
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
            })
        {
            return Err(bad("invalid language contribution"));
        }
    }
    Ok(m)
}

/// All asset paths a manifest references.
pub fn assets(m: &Manifest) -> Vec<String> {
    let c = &m.contributes;
    let mut v: Vec<String> =
        c.themes.iter().chain(c.icon_packs.iter()).cloned().chain(c.snippets.iter().map(|s| s.path.clone())).collect();
    v.sort();
    v.dedup();
    v
}

/// Read and validate an extension folder: manifest + referenced JSON assets.
pub fn read_source(dir: &Path) -> AppResult<(Manifest, BTreeMap<String, String>)> {
    let read = |p: &Path, max: u64| -> AppResult<String> {
        let meta = std::fs::symlink_metadata(p).map_err(|_| bad(format!("missing file {}", p.display())))?;
        if !meta.is_file() {
            return Err(bad(format!("{} is not a regular file", p.display())));
        }
        if meta.len() > max {
            return Err(bad(format!("{} is too large", p.display())));
        }
        String::from_utf8(std::fs::read(p)?).map_err(|_| bad(format!("{} is not UTF-8", p.display())))
    };
    let manifest = parse_manifest(read(&dir.join(MANIFEST), MAX_MANIFEST)?.trim_start_matches('\u{feff}'))?;
    let list = assets(&manifest);
    if list.len() > MAX_FILES {
        return Err(bad("too many files"));
    }
    let root = dunce::canonicalize(dir)?;
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    for rel in list {
        let p = dunce::canonicalize(dir.join(&rel)).map_err(|_| bad(format!("missing file {rel}")))?;
        if !p.starts_with(&root) {
            return Err(bad(format!("{rel} points outside the extension")));
        }
        let text = read(&p, MAX_FILE)?;
        serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
            .map_err(|e| bad(format!("{rel} is not valid JSON: {e}")))?;
        total += text.len() as u64;
        if total > MAX_TOTAL {
            return Err(bad("the extension is too large"));
        }
        files.insert(rel, text);
    }
    Ok((manifest, files))
}

/// Install into `<base>/<id>`: written to a staging folder first, then swapped in.
pub fn install(base: &Path, manifest: &Manifest, files: &BTreeMap<String, String>) -> AppResult<PathBuf> {
    if !valid_id(&manifest.id) {
        return Err(bad("invalid id"));
    }
    std::fs::create_dir_all(base)?;
    let target = base.join(&manifest.id);
    let staging = base.join(format!(".{}.staging-{}", manifest.id, crate::core::now_ms()));
    std::fs::create_dir_all(&staging)?;
    let write = || -> AppResult<()> {
        std::fs::write(
            staging.join(MANIFEST),
            serde_json::to_vec_pretty(manifest).map_err(|e| AppError::Internal(e.to_string()))?,
        )?;
        for (rel, text) in files {
            if !valid_asset(rel) {
                return Err(bad(format!("invalid asset path '{rel}'")));
            }
            let p = staging.join(rel);
            if let Some(d) = p.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(p, text)?;
        }
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if target.exists() {
        let old = base.join(format!(".{}.old-{}", manifest.id, crate::core::now_ms()));
        std::fs::rename(&target, &old)?;
        if let Err(e) = std::fs::rename(&staging, &target) {
            let _ = std::fs::rename(&old, &target);
            return Err(e.into());
        }
        let _ = std::fs::remove_dir_all(&old);
    } else {
        std::fs::rename(&staging, &target)?;
    }
    Ok(target)
}

/// Installed extensions (invalid folders are reported, not loaded).
/// An extension read from disk: manifest and asset texts.
pub type Loaded = (Manifest, BTreeMap<String, String>);

pub fn list_installed(base: &Path) -> (Vec<Loaded>, Vec<String>) {
    let mut out = Vec::new();
    let mut issues = Vec::new();
    let Ok(rd) = std::fs::read_dir(base) else { return (out, issues) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        match read_source(&e.path()) {
            Ok((m, files)) if m.id == name => out.push((m, files)),
            Ok(_) => issues.push(format!("{name}: the folder name does not match the extension id")),
            Err(err) => issues.push(format!("{name}: {err}")),
        }
    }
    out.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    (out, issues)
}

/// Remove an installed extension (only folders directly inside `base` with a valid id).
pub fn uninstall(base: &Path, id: &str) -> AppResult<()> {
    if !valid_id(id) {
        return Err(bad("invalid id"));
    }
    let p = base.join(id);
    if p.is_dir() {
        std::fs::remove_dir_all(p)?;
    }
    Ok(())
}

/// Recommended extension ids from `.ivily/extensions.json` of the workspace folders.
pub fn recommendations(roots: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    for r in roots {
        let p = r.join(".ivily").join("extensions.json");
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if !meta.is_file() || meta.len() > 64 * 1024 {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        if let Ok(v) = crate::tasks::jsonc::parse(&text) {
            for id in v.get("recommendations").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
            {
                if valid_id(id) && !out.iter().any(|x| x == id) {
                    out.push(id.to_string());
                }
            }
        }
    }
    out.truncate(50);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(dir: &Path) {
        std::fs::create_dir_all(dir.join("themes")).unwrap();
        std::fs::write(
            dir.join(MANIFEST),
            r#"{ "id": "acme.sea", "name": "Sea", "version": "1.0.0", "publisher": "Acme",
                 "contributes": { "themes": ["themes/sea.json"], "keybindings": [{ "key": "Ctrl+Alt+R", "command": "tasks.run" }],
                                  "languages": [{ "id": "markdown", "extensions": [".mdx"] }] } }"#,
        )
        .unwrap();
        std::fs::write(dir.join("themes/sea.json"), r#"{ "id": "sea", "name": "Sea" }"#).unwrap();
    }

    #[test]
    fn validates_ids_and_asset_paths() {
        assert!(valid_id("acme.sea-theme"));
        assert!(!valid_id("Acme.sea") && !valid_id("acme") && !valid_id("a.b.c") && !valid_id("a..b"));
        assert!(valid_asset("themes/a.json"));
        for bad in ["../x.json", "/x.json", "C:/x.json", "a\\b.json", "themes/a.js", "./a.json"] {
            assert!(!valid_asset(bad), "{bad}");
        }
        assert!(parse_manifest(
            r#"{ "id": "a.b", "name": "x", "version": "1", "contributes": { "themes": ["../evil.json"] } }"#
        )
        .is_err());
        assert!(parse_manifest(r#"{ "id": "a.b", "name": "x", "version": "1", "contributes": { "keybindings": [{ "key": "F1", "command": "-workbench.commandPalette" }] } }"#).is_err());
    }

    #[test]
    fn reads_installs_lists_and_uninstalls() {
        let src = tempfile::tempdir().unwrap();
        sample(src.path());
        std::fs::write(src.path().join("unreferenced.exe"), "MZ").unwrap();
        let (m, files) = read_source(src.path()).unwrap();
        assert_eq!(m.id, "acme.sea");
        assert_eq!(files.keys().collect::<Vec<_>>(), vec!["themes/sea.json"]);
        let base = tempfile::tempdir().unwrap();
        let target = install(base.path(), &m, &files).unwrap();
        assert!(target.join("themes/sea.json").is_file());
        assert!(!target.join("unreferenced.exe").exists(), "only referenced JSON files are copied");
        // Reinstall replaces atomically.
        install(base.path(), &m, &files).unwrap();
        let (list, issues) = list_installed(base.path());
        assert_eq!(list.len(), 1);
        assert!(issues.is_empty());
        assert_eq!(std::fs::read_dir(base.path()).unwrap().count(), 1, "no staging leftovers");
        uninstall(base.path(), "acme.sea").unwrap();
        assert!(list_installed(base.path()).0.is_empty());
        assert!(uninstall(base.path(), "../x").is_err());
    }

    #[test]
    fn rejects_missing_or_invalid_assets() {
        let src = tempfile::tempdir().unwrap();
        sample(src.path());
        std::fs::write(src.path().join("themes/sea.json"), "{ not json").unwrap();
        assert!(read_source(src.path()).is_err());
        std::fs::remove_file(src.path().join("themes/sea.json")).unwrap();
        assert!(read_source(src.path()).is_err());
    }

    #[test]
    fn reads_workspace_recommendations() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".ivily")).unwrap();
        std::fs::write(
            d.path().join(".ivily/extensions.json"),
            r#"{ // c
            "recommendations": ["acme.sea", "Bad.Id", "acme.sea"] }"#,
        )
        .unwrap();
        assert_eq!(recommendations(&[d.path().to_path_buf()]), vec!["acme.sea"]);
    }
}
