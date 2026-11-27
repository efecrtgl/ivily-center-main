//! Fuzzy file matching for Quick Open (scored in the backend so large workspaces never send their
//! whole file list to the UI).

/// Score `query` against a relative path. All query characters must appear in order
/// (case-insensitive). Matches in the file name, consecutive matches and matches at word starts
/// score higher; shorter paths win ties. Returns `None` when it does not match.
pub fn score(query: &str, path: &str) -> Option<i64> {
    let q: Vec<char> = query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    if q.is_empty() {
        return Some(0);
    }
    let lower: Vec<char> = path.chars().flat_map(char::to_lowercase).collect();
    let chars: Vec<char> = path.chars().collect();
    if lower.len() != chars.len() {
        return None; // unusual case mapping; skip rather than mis-highlight
    }
    let name_start = path.rfind(['/', '\\']).map(|i| path[..=i].chars().count()).unwrap_or(0);
    let mut score = 0i64;
    let mut qi = 0;
    let mut prev: Option<usize> = None;
    for (i, c) in lower.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            let boundary = i == 0
                || matches!(chars[i - 1], '/' | '\\' | '.' | '_' | '-' | ' ')
                || (chars[i].is_uppercase() && chars[i - 1].is_lowercase());
            score += 1;
            if prev == Some(i.wrapping_sub(1)) {
                score += 6;
            }
            if boundary {
                score += 4;
            }
            if i >= name_start {
                score += 3;
            }
            prev = Some(i);
            qi += 1;
        }
    }
    if qi < q.len() {
        return None;
    }
    // Exact file-name prefix bonus, shorter paths first.
    let name: String = lower[name_start..].iter().collect();
    let qs: String = q.iter().collect();
    if name.starts_with(&qs) {
        score += 20;
    }
    Some(score * 1000 - lower.len() as i64)
}

/// Best `limit` matches, highest score first.
pub fn best<'a>(query: &str, paths: impl Iterator<Item = (usize, &'a str)>, limit: usize) -> Vec<(usize, String, i64)> {
    let mut scored: Vec<(usize, String, i64)> =
        paths.filter_map(|(root, p)| score(query, p).map(|s| (root, p.to_string(), s))).collect();
    scored.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    scored.truncate(limit);
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_file_names_and_word_starts() {
        let paths = [
            "src/features/editor/model.js",
            "src/features/explorer/model.js",
            "docs/EDITOR.md",
            "src/main.jsx",
            "node/somewhere/edm.txt",
        ];
        let r = best("edmod", paths.iter().map(|p| (0, *p)), 10);
        assert_eq!(r[0].1, "src/features/editor/model.js");
        let r = best("main", paths.iter().map(|p| (0, *p)), 10);
        assert_eq!(r[0].1, "src/main.jsx");
        assert!(score("xyz", "src/main.jsx").is_none());
        assert_eq!(score("", "anything"), Some(0));
    }
}
