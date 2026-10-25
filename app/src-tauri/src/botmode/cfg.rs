//! Reading and merging convar lines in a cfg the user also edits by hand.
//!
//! A "simple" line is one command, `name value`, optionally followed by a `//` comment.
//! Merging rewrites the value of every simple line that sets a known convar, keeps the line's
//! indentation and comment, and leaves every other line alone. A convar with no simple line
//! is appended. So is one that a later compound line (`a 1; name 2`) also sets, because the
//! game applies the last value it reads.

fn split_comment(line: &str) -> (&str, &str) {
    match line.find("//") {
        Some(i) => (&line[..i], &line[i..]),
        None => (line, ""),
    }
}

/// `(name, value)` when `line` is a single uncommented command with one argument.
fn simple(line: &str) -> Option<(&str, &str)> {
    let (code, _) = split_comment(line);
    if code.contains(';') {
        return None;
    }
    let mut t = code.split_whitespace();
    let (name, value) = (t.next()?, t.next()?);
    t.next().is_none().then_some((name, value.trim_matches('"')))
}

/// Whether a compound or multi-argument line also sets `name`.
fn mentions(line: &str, name: &str) -> bool {
    let (code, _) = split_comment(line);
    code.split(';').any(|cmd| cmd.split_whitespace().next().is_some_and(|t| t.eq_ignore_ascii_case(name)))
}

/// The value the game ends up with: the last uncommented simple line that sets `name`.
pub fn read(text: &str, name: &str) -> Option<String> {
    text.lines()
        .filter_map(simple)
        .filter(|(n, _)| n.eq_ignore_ascii_case(name))
        .last()
        .map(|(_, v)| v.to_string())
}

/// Sets each `(name, value)` in `text`. See the module notes for the rules.
pub fn merge(text: &str, values: &[(&str, String)]) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    for (name, value) in values {
        let mut last_simple = None;
        let mut last_any = None;
        for (i, line) in lines.iter_mut().enumerate() {
            if let Some((n, _)) = simple(line) {
                if n.eq_ignore_ascii_case(name) {
                    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                    let (code, comment) = split_comment(line);
                    let gap = if comment.is_empty() { "" } else { &code[code.trim_end().len()..] };
                    *line = format!("{indent}{n} {value}{gap}{comment}");
                    last_simple = Some(i);
                    last_any = Some(i);
                    continue;
                }
            }
            if mentions(line, name) {
                last_any = Some(i);
            }
        }
        if last_simple.is_none() || last_simple != last_any {
            lines.push(format!("{name} {value}"));
        }
    }
    let mut out = lines.join(eol);
    out.push_str(eol);
    out
}

/// Adds the lines of `incoming` that set a convar in `known` and that `user` does not set,
/// for a package that ships its own copy of a protected cfg. The user's values win.
pub fn add_missing(user: &str, incoming: &str, known: &[&str]) -> String {
    let missing: Vec<(&str, String)> = known
        .iter()
        .filter(|name| read(user, name).is_none())
        .filter_map(|name| read(incoming, name).map(|v| (*name, v)))
        .collect();
    if missing.is_empty() {
        return user.to_string();
    }
    merge(user, &missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's real `gamemode_competitive_server.cfg`, shortened.
    const USER: &str = "// Local settings, run by CS2 on every competitive map load.\r\n\r\n// BotRandomizer: random finishes on dropped knives\r\nbr_dropped_knife_skins 1\r\nbr_dropped_knife_premium 0 // favor expensive finishes\r\nmp_maxrounds 24\r\nbr_player_music_kit 33\r\n";

    #[test]
    fn merging_changes_only_the_known_values_and_keeps_comments() {
        let out = merge(
            USER,
            &[("br_dropped_knife_premium", "1".into()), ("br_player_music_kit", "-1".into()), ("br_dropped_knife_skins", "1".into())],
        );
        assert_eq!(
            out,
            "// Local settings, run by CS2 on every competitive map load.\r\n\r\n// BotRandomizer: random finishes on dropped knives\r\nbr_dropped_knife_skins 1\r\nbr_dropped_knife_premium 1 // favor expensive finishes\r\nmp_maxrounds 24\r\nbr_player_music_kit -1\r\n"
        );
    }

    #[test]
    fn a_missing_convar_is_appended_and_a_later_compound_line_is_overridden() {
        let text = "mp_maxrounds 24\nbr_player_music_kit 5\nsay hi; br_player_music_kit 9\n";
        let out = merge(text, &[("br_player_music_kit", "33".into()), ("br_dropped_knife_skins", "0".into())]);
        assert_eq!(out, "mp_maxrounds 24\nbr_player_music_kit 33\nsay hi; br_player_music_kit 9\nbr_player_music_kit 33\nbr_dropped_knife_skins 0\n");
        assert_eq!(read(&out, "br_player_music_kit").as_deref(), Some("33"));
    }

    #[test]
    fn commented_lines_are_not_read_as_values() {
        assert_eq!(read("// br_player_music_kit 7\nbr_player_music_kit \"12\"\n", "br_player_music_kit").as_deref(), Some("12"));
        assert_eq!(read("// br_player_music_kit 7\n", "br_player_music_kit"), None);
    }

    #[test]
    fn a_shipped_copy_never_overrides_the_users_values() {
        let out = add_missing(USER, "br_player_music_kit 0\nbr_new_convar 1\n", &["br_player_music_kit", "br_new_convar"]);
        assert_eq!(read(&out, "br_player_music_kit").as_deref(), Some("33"));
        assert_eq!(read(&out, "br_new_convar").as_deref(), Some("1"));
    }
}
