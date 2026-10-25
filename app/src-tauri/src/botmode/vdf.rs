//! Reader for Valve's text KeyValues format, used by Steam's `libraryfolders.vdf`,
//! `appmanifest_*.acf` and `localconfig.vdf`. Keys are matched without regard to case,
//! because Steam writes both `apps` and `Apps` in different files.

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Str(String),
    Map(Vec<(String, Node)>),
}

impl Node {
    /// The first child named `key`, ignoring case.
    pub fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Map(items) => items.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Node::Str(_) => None,
        }
    }

    /// The child named `key`, ignoring case, when there is at most one. Two children with the
    /// same name is an error: which one a reader honours would be a guess.
    pub fn get_unique(&self, key: &str) -> Result<Option<&Node>, String> {
        let mut found = self.entries().iter().filter(|(k, _)| k.eq_ignore_ascii_case(key));
        let first = found.next().map(|(_, v)| v);
        if found.next().is_some() {
            return Err(format!("key \"{key}\" appears more than once"));
        }
        Ok(first)
    }

    /// Follows a chain of keys.
    pub fn path(&self, keys: &[&str]) -> Option<&Node> {
        keys.iter().try_fold(self, |n, k| n.get(k))
    }

    pub fn str(&self) -> Option<&str> {
        match self {
            Node::Str(s) => Some(s),
            Node::Map(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Node)] {
        match self {
            Node::Map(items) => items,
            Node::Str(_) => &[],
        }
    }
}

enum Tok {
    Str(String),
    Open,
    Close,
}

fn tokenize(text: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {}
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            // Platform conditionals such as [$WIN32] follow a value; they carry no data we use.
            '[' => {
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                }
            }
            '"' => {
                let mut s = String::new();
                loop {
                    match chars.next() {
                        None => return Err("unterminated quoted string".into()),
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(other) => s.push(other),
                            None => return Err("unterminated escape".into()),
                        },
                        Some(other) => s.push(other),
                    }
                }
                out.push(Tok::Str(s));
            }
            c => {
                let mut s = String::from(c);
                while let Some(&n) = chars.peek() {
                    if n.is_whitespace() || n == '{' || n == '}' || n == '"' {
                        break;
                    }
                    s.push(n);
                    chars.next();
                }
                out.push(Tok::Str(s));
            }
        }
    }
    Ok(out)
}

/// Parses a whole file. The result is a map holding the top-level keys.
pub fn parse(text: &str) -> Result<Node, String> {
    let toks = tokenize(text.trim_start_matches('\u{feff}'))?;
    let mut pos = 0;
    let root = parse_map(&toks, &mut pos, true)?;
    Ok(root)
}

fn parse_map(toks: &[Tok], pos: &mut usize, top: bool) -> Result<Node, String> {
    let mut items = Vec::new();
    loop {
        match toks.get(*pos) {
            None if top => return Ok(Node::Map(items)),
            None => return Err("missing closing brace".into()),
            Some(Tok::Close) if !top => {
                *pos += 1;
                return Ok(Node::Map(items));
            }
            Some(Tok::Close) | Some(Tok::Open) => return Err(format!("unexpected brace at token {}", *pos)),
            Some(Tok::Str(key)) => {
                *pos += 1;
                let value = match toks.get(*pos) {
                    Some(Tok::Str(v)) => {
                        *pos += 1;
                        Node::Str(v.clone())
                    }
                    Some(Tok::Open) => {
                        *pos += 1;
                        parse_map(toks, pos, false)?
                    }
                    _ => return Err(format!("key \"{key}\" has no value")),
                };
                items.push((key.clone(), value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_steam_library_paths_with_escaped_backslashes() {
        let text = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t\t\"apps\"\n\t\t{\n\t\t\t\"730\"\t\t\"1\"\n\t\t}\n\t}\n}\n";
        let root = parse(text).unwrap();
        let lib = root.path(&["libraryfolders", "0"]).unwrap();
        assert_eq!(lib.get("path").and_then(Node::str), Some(r"C:\Program Files (x86)\Steam"));
        assert!(lib.path(&["Apps", "730"]).is_some(), "keys match without case");
    }

    #[test]
    fn an_unbalanced_file_is_an_error() {
        assert!(parse("\"a\"\n{\n\"b\" \"c\"\n").is_err());
    }
}
