//! Minimal JSON-with-comments reader (as used by `tasks.json`): strips `//` and `/* */` comments
//! and trailing commas outside strings, then parses with serde_json.

use serde_json::Value;

pub fn strip(input: &str) -> String {
    let b: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
                i += 1;
            }
            '/' if b.get(i + 1) == Some(&'/') => {
                while i < b.len() && b[i] != '\n' {
                    i += 1;
                }
            }
            '/' if b.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            ',' => {
                // Drop a comma followed only by whitespace/comments and a closing bracket.
                let mut j = i + 1;
                loop {
                    while j < b.len() && b[j].is_whitespace() {
                        j += 1;
                    }
                    if b.get(j) == Some(&'/') && b.get(j + 1) == Some(&'/') {
                        while j < b.len() && b[j] != '\n' {
                            j += 1;
                        }
                    } else if b.get(j) == Some(&'/') && b.get(j + 1) == Some(&'*') {
                        j += 2;
                        while j + 1 < b.len() && !(b[j] == '*' && b[j + 1] == '/') {
                            j += 1;
                        }
                        j += 2;
                    } else {
                        break;
                    }
                }
                if !matches!(b.get(j), Some('}') | Some(']')) {
                    out.push(',');
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

pub fn parse(input: &str) -> Result<Value, String> {
    serde_json::from_str(&strip(input.trim_start_matches('\u{feff}'))).map_err(|e| format!("invalid JSON: {e}"))
}
