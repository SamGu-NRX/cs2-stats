//! Reading and merging convar lines in a cfg the user also edits by hand.
//!
//! Lines are read the way the console reads them: `;` separates commands and `//` starts a
//! comment, both only outside double quotes, so `say hi; br_player_music_kit 5` sets the convar
//! and `alias x "a; br_player_music_kit 5"` does not. A command with a name and exactly one
//! argument sets a value. A "simple" line is one such command, optionally followed by a comment.
//!
//! Merging rewrites the value of every simple line that sets a known convar, keeps the line's
//! indentation and comment, and leaves every other line alone. A convar with no simple line
//! is appended. So is one that a later compound line also sets, because the game applies the
//! last value it reads.

/// A line's commands, and its comment (empty when there is none).
fn commands(line: &str) -> (Vec<&str>, &str) {
    let b = line.as_bytes();
    let (mut out, mut start, mut quoted) = (Vec::new(), 0, false);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => quoted = !quoted,
            b';' if !quoted => {
                out.push(&line[start..i]);
                start = i + 1;
            }
            b'/' if !quoted && b.get(i + 1) == Some(&b'/') => {
                out.push(&line[start..i]);
                return (out, &line[i..]);
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&line[start..]);
    (out, "")
}

/// A command's words. A quoted word keeps its spaces and loses its quotes.
fn words(cmd: &str) -> Vec<&str> {
    let b = cmd.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < b.len() {
        if b[i].is_ascii_whitespace() {
            i += 1;
        } else if b[i] == b'"' {
            let s = i + 1;
            let mut j = s;
            while j < b.len() && b[j] != b'"' {
                j += 1;
            }
            out.push(&cmd[s..j]);
            i = j + 1;
        } else {
            let s = i;
            while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'"' {
                i += 1;
            }
            out.push(&cmd[s..i]);
        }
    }
    out
}

/// `(name, value)` when `cmd` is a name and exactly one argument.
fn setting(cmd: &str) -> Option<(&str, &str)> {
    match words(cmd).as_slice() {
        [name, value] => Some((name, value)),
        _ => None,
    }
}

fn split_comment(line: &str) -> (&str, &str) {
    let (_, comment) = commands(line);
    (&line[..line.len() - comment.len()], comment)
}

/// `(name, value)` when `line` holds exactly one command and it sets a value.
fn simple(line: &str) -> Option<(&str, &str)> {
    let (cmds, _) = commands(line);
    match cmds.iter().filter(|c| !c.trim().is_empty()).collect::<Vec<_>>().as_slice() {
        [only] => setting(only),
        _ => None,
    }
}

/// Whether any command on the line is `name`.
fn mentions(line: &str, name: &str) -> bool {
    commands(line).0.iter().any(|c| words(c).first().is_some_and(|w| w.eq_ignore_ascii_case(name)))
}

/// The words of a line that holds exactly one command (a comment after it allowed); `None`
/// for an empty line, a comment, or a line with several commands.
pub fn line_words(line: &str) -> Option<Vec<&str>> {
    let (cmds, _) = commands(line);
    match cmds.iter().filter(|c| !c.trim().is_empty()).collect::<Vec<_>>().as_slice() {
        [only] => Some(words(only)),
        _ => None,
    }
}

/// Every command in `text`, in the order the game runs them, with its words and the line it is on.
pub fn commands_of(text: &str) -> Vec<(&str, Vec<&str>)> {
    text.lines().flat_map(|l| commands(l).0.into_iter().map(move |c| (l, words(c)))).filter(|(_, w)| !w.is_empty()).collect()
}

/// Whether a command's words are `exec <file>`: the name in any case, with or without quotes
/// (`words` drops them) and with or without a `.cfg` suffix in any case.
pub fn is_exec_of(words: &[&str], file: &str) -> bool {
    match words {
        [cmd, arg] => {
            let arg = arg.to_ascii_lowercase();
            cmd.eq_ignore_ascii_case("exec") && (arg == file.to_ascii_lowercase() || arg.strip_suffix(".cfg") == Some(&file.to_ascii_lowercase()))
        }
        _ => false,
    }
}

/// Whether any command in `text` is `exec <file>` (see [`is_exec_of`]).
pub fn execs(text: &str, file: &str) -> bool {
    commands_of(text).iter().any(|(_, w)| is_exec_of(w, file))
}

/// Every value-setting command in `text`, in the order the game runs them.
fn settings(text: &str) -> impl Iterator<Item = (&str, &str)> {
    text.lines().flat_map(|l| commands(l).0).filter_map(setting)
}

/// The value the game ends up with: the last command anywhere that sets `name`.
pub fn read(text: &str, name: &str) -> Option<String> {
    settings(text).filter(|(n, _)| n.eq_ignore_ascii_case(name)).last().map(|(_, v)| v.to_string())
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

/// Console commands that take one argument but are actions, not settings. A user's
/// `exec other.cfg` is not a value to carry into a new release's cfg, and treating it as one
/// would rewrite the release's own `exec` lines.
const COMMANDS: [&str; 18] = [
    "exec", "echo", "say", "say_team", "unbind", "bind", "alias", "toggle", "incrementvar", "map", "changelevel",
    "connect", "play", "give", "bot_add", "bot_add_t", "bot_add_ct", "bot_kick",
];

/// A release's copy of a mod cfg with the user's settings kept: every convar the user's copy
/// sets to a value the release's copy does not have is set to the user's value (in place,
/// or appended). The release's other lines, including `bind` and `alias` lines, win.
pub fn keep_user_values(release: &str, user: &str) -> String {
    let mut carried: Vec<(&str, String)> = Vec::new();
    for (name, _) in settings(user) {
        if COMMANDS.iter().any(|c| c.eq_ignore_ascii_case(name)) || carried.iter().any(|(n, _)| n.eq_ignore_ascii_case(name)) {
            continue;
        }
        let Some(mine) = read(user, name) else { continue };
        if read(release, name).as_deref() != Some(mine.as_str()) {
            carried.push((name, mine));
        }
    }
    if carried.is_empty() {
        return release.to_string();
    }
    merge(release, &carried)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The user's real `gamemode_competitive_server.cfg`, shortened.
    const USER: &str = "// Local settings, run by CS2 on every competitive map load.\r\n\r\n// BotRandomizer: random finishes on dropped knives\r\nbr_dropped_knife_skins 1\r\nbr_dropped_knife_premium 0 // favor expensive finishes\r\nmp_maxrounds 24\r\nbr_player_music_kit 33\r\n";

    #[test]
    fn exec_of_a_file_is_found_in_any_case_with_or_without_quotes_and_suffix() {
        for line in ["exec cs2stats_knife", "EXEC cs2stats_knife.CFG", "exec \"cs2stats_knife\"", "exec \"CS2Stats_Knife.cfg\" // mine", "say hi; exec cs2stats_knife.Cfg"] {
            assert!(execs(line, "cs2stats_knife"), "{line}");
        }
        for line in ["// exec cs2stats_knife", "exec cs2stats_knife2", "exec other.cfg", "alias x \"exec cs2stats_knife\""] {
            assert!(!execs(line, "cs2stats_knife"), "{line}");
        }
    }

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
    fn a_compound_line_sets_the_convar_but_a_quoted_alias_body_does_not() {
        let text = "br_player_music_kit 3\nsay hi; br_player_music_kit 5\n";
        assert_eq!(read(text, "br_player_music_kit").as_deref(), Some("5"));
        let quoted = "br_player_music_kit 3\nalias x \"say a; br_player_music_kit 9\"\nsay \"http://example.com\"; br_dropped_knife_skins 1\n";
        assert_eq!(read(quoted, "br_player_music_kit").as_deref(), Some("3"));
        assert_eq!(read(quoted, "br_dropped_knife_skins").as_deref(), Some("1"), "// inside quotes is not a comment");
        // Setting a value the compound line overrides appends a line that wins.
        let out = merge(text, &[("br_player_music_kit", "33".into())]);
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
