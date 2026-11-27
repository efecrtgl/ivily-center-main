//! Project discovery for the launcher: list the immediate sub-folders of a folder the user picked
//! that look like projects. Read-only and shallow by design — only existence checks of marker
//! files, no file contents read, no recursion, symlinks/junctions not followed, bounded count.

use super::paths::{folder_name, normalize_dir, NormalizedPath};
use crate::error::AppResult;
use serde::Serialize;
use std::path::Path;

pub const MAX_ENTRIES: usize = 2000;
pub const MAX_RESULTS: usize = 300;

/// (marker file or directory, label). `*.ext` matches any file with that extension.
const MARKERS: &[(&str, &str)] = &[
    (".git", "Git"),
    ("Cargo.toml", "Rust"),
    ("package.json", "Node.js"),
    ("deno.json", "Deno"),
    ("pyproject.toml", "Python"),
    ("requirements.txt", "Python"),
    ("go.mod", "Go"),
    ("pom.xml", "Java"),
    ("build.gradle", "Gradle"),
    ("build.gradle.kts", "Gradle"),
    ("*.sln", ".NET"),
    ("*.csproj", ".NET"),
    ("composer.json", "PHP"),
    ("Gemfile", "Ruby"),
    ("CMakeLists.txt", "C/C++"),
    ("Makefile", "Make"),
    ("build.zig", "Zig"),
    ("Package.swift", "Swift"),
    ("*.ivily-workspace", "Ivily workspace"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub path: String,
    pub markers: Vec<&'static str>,
    #[serde(skip)]
    pub location: NormalizedPath,
}

fn is_link(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_symlink()).unwrap_or(true)
}

fn markers_in(dir: &Path) -> Vec<&'static str> {
    let mut found: Vec<&'static str> = Vec::new();
    let mut ext_names: Option<Vec<String>> = None;
    for (marker, label) in MARKERS {
        let hit = if let Some(ext) = marker.strip_prefix("*.") {
            let names = ext_names.get_or_insert_with(|| {
                std::fs::read_dir(dir)
                    .map(|rd| {
                        rd.filter_map(|e| e.ok())
                            .take(MAX_ENTRIES)
                            .map(|e| e.file_name().to_string_lossy().to_lowercase())
                            .collect()
                    })
                    .unwrap_or_default()
            });
            let suffix = format!(".{}", ext.to_lowercase());
            names.iter().any(|n| n.ends_with(&suffix))
        } else {
            dir.join(marker).exists()
        };
        if hit && !found.contains(label) {
            found.push(label);
        }
    }
    found
}

/// Discover project folders directly inside `root` (and `root` itself).
pub fn discover(root: &Path) -> AppResult<Vec<Candidate>> {
    let root = normalize_dir(root)?;
    let mut out = Vec::new();
    let own = markers_in(&root.path);
    if !own.is_empty() {
        out.push(Candidate {
            name: folder_name(&root.path),
            path: root.display(),
            markers: own,
            location: root.clone(),
        });
    }
    let mut entries: Vec<_> = std::fs::read_dir(&root.path)?.filter_map(|e| e.ok()).take(MAX_ENTRIES).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        if out.len() >= MAX_RESULTS {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || name.starts_with('$')
            || is_link(&entry)
            || !entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
        {
            continue;
        }
        let markers = markers_in(&entry.path());
        if markers.is_empty() {
            continue;
        }
        if let Ok(location) = normalize_dir(&entry.path()) {
            out.push(Candidate { name, path: location.display(), markers, location });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_marked_subfolders_only() {
        let dir = tempfile::tempdir().unwrap();
        let mk = |p: &str| std::fs::create_dir_all(dir.path().join(p)).unwrap();
        mk("rust-app");
        std::fs::write(dir.path().join("rust-app/Cargo.toml"), "").unwrap();
        mk("rust-app/.git");
        mk("web");
        std::fs::write(dir.path().join("web/package.json"), "{}").unwrap();
        mk("dotnet");
        std::fs::write(dir.path().join("dotnet/App.CSPROJ"), "").unwrap();
        mk("plain");
        mk(".hidden");
        std::fs::write(dir.path().join(".hidden/package.json"), "{}").unwrap();
        mk("deep/inner");
        std::fs::write(dir.path().join("deep/inner/Cargo.toml"), "").unwrap();

        let found = discover(dir.path()).unwrap();
        let names: Vec<_> = found.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["dotnet", "rust-app", "web"]);
        assert_eq!(found[1].markers, vec!["Git", "Rust"]);
        assert_eq!(found[0].markers, vec![".NET"]);
    }

    #[test]
    fn includes_the_root_when_it_is_a_project() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("go.mod"), "").unwrap();
        assert_eq!(discover(dir.path()).unwrap()[0].markers, vec!["Go"]);
    }
}
