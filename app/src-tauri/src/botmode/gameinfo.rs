//! The `gameinfo.gi` change that turns Bot Mode on: two `Game` search paths that load the
//! mod's bot profile and Metamod ahead of the base game.
//!
//! The mod's README installs Bot Mode by copying its whole `gameinfo.gi` (the same file as
//! `backup\WithBots\gameinfo.gi`) over the game's. Bot Mode inserts the two lines into the
//! game's current file instead. In v1.4.7 the two lines are the only difference between the
//! release's `backup\Online` and `backup\WithBots` copies, while the release's copy and the
//! installed game's differ elsewhere (line 593, a `"game" "SkyOccluder"` shader layer). Copying
//! the whole file would undo whatever Valve changed in `gameinfo.gi` since the release was cut.

/// The search paths Bot Mode needs, in order, each as `Game <path>`.
pub const BOT_SEARCH_PATHS: [&str; 2] = ["csgo/overrides/botprofile.vpk", "csgo/addons/metamod"];

struct Block {
    /// (line index, key, value) of each entry inside `SearchPaths { }`.
    entries: Vec<(usize, String, String)>,
}

fn search_paths(text: &str) -> Result<Block, String> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines
        .iter()
        .position(|l| l.split_whitespace().next().is_some_and(|t| t.eq_ignore_ascii_case("SearchPaths")))
        .ok_or("gameinfo.gi has no SearchPaths block")?;
    let mut depth = 0;
    let mut opened = false;
    let mut entries = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(start) {
        let code = line.split("//").next().unwrap_or("");
        for c in code.chars() {
            match c {
                '{' => {
                    depth += 1;
                    opened = true;
                }
                '}' => depth -= 1,
                _ => {}
            }
        }
        if opened && depth == 0 {
            return Ok(Block { entries });
        }
        if i > start && depth == 1 {
            let mut t = code.split_whitespace();
            if let (Some(k), Some(v)) = (t.next(), t.next()) {
                entries.push((i, k.to_string(), v.to_string()));
            }
        }
    }
    Err("gameinfo.gi: the SearchPaths block is not closed".into())
}

fn is_game(k: &str, v: &str, path: &str) -> bool {
    k.eq_ignore_ascii_case("Game") && v.eq_ignore_ascii_case(path)
}

fn base_line(block: &Block) -> Result<usize, String> {
    block
        .entries
        .iter()
        .find(|(_, k, v)| is_game(k, v, "csgo"))
        .map(|(i, _, _)| *i)
        .ok_or_else(|| "gameinfo.gi: SearchPaths has no `Game csgo` entry".to_string())
}

/// True when both bot search paths come before `Game csgo`, which is what makes them win.
pub fn is_bot_mode(text: &str) -> Result<bool, String> {
    let block = search_paths(text)?;
    let base = base_line(&block)?;
    Ok(BOT_SEARCH_PATHS
        .iter()
        .all(|p| block.entries.iter().any(|(i, k, v)| *i < base && is_game(k, v, p))))
}

/// Returns `text` with the bot search paths inserted just above `Game csgo`, keeping every
/// other line and the file's line endings. A bot path found below `Game csgo`, where it has
/// no effect, is moved.
pub fn enable(text: &str) -> Result<String, String> {
    if is_bot_mode(text)? {
        return Ok(text.to_string());
    }
    let block = search_paths(text)?;
    let base = base_line(&block)?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = text.lines().collect();
    let indent: String = lines[base].chars().take_while(|c| c.is_whitespace()).collect();
    let misplaced: Vec<usize> = block
        .entries
        .iter()
        .filter(|(i, k, v)| *i > base && BOT_SEARCH_PATHS.iter().any(|p| is_game(k, v, p)))
        .map(|(i, _, _)| *i)
        .collect();
    let mut out = Vec::with_capacity(lines.len() + 2);
    for (i, line) in lines.iter().enumerate() {
        if i == base {
            for p in BOT_SEARCH_PATHS {
                let present = block.entries.iter().any(|(j, k, v)| *j < base && is_game(k, v, p));
                if !present {
                    out.push(format!("{indent}Game\t{p}"));
                }
            }
        }
        if !misplaced.contains(&i) {
            out.push(line.to_string());
        }
    }
    let mut joined = out.join(eol);
    if text.ends_with('\n') {
        joined.push_str(eol);
    }
    Ok(joined)
}

/// The lines [`disable`] removes from `text`, trimmed: every bot search path in `SearchPaths`,
/// whichever tool added it.
pub fn bot_lines(text: &str) -> Result<Vec<String>, String> {
    let block = search_paths(text)?;
    let lines: Vec<&str> = text.lines().collect();
    Ok(block
        .entries
        .iter()
        .filter(|(_, k, v)| BOT_SEARCH_PATHS.iter().any(|p| is_game(k, v, p)))
        .map(|(i, _, _)| lines[*i].trim().to_string())
        .collect())
}

/// Returns `text` without the bot search paths, keeping every other line and the file's line
/// endings. The mod's files stay on disk; without these lines CS2 does not load them.
pub fn disable(text: &str) -> Result<String, String> {
    let block = search_paths(text)?;
    let drop: Vec<usize> = block
        .entries
        .iter()
        .filter(|(_, k, v)| BOT_SEARCH_PATHS.iter().any(|p| is_game(k, v, p)))
        .map(|(i, _, _)| *i)
        .collect();
    if drop.is_empty() {
        return Ok(text.to_string());
    }
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let kept: Vec<&str> = text.lines().enumerate().filter(|(i, _)| !drop.contains(i)).map(|(_, l)| l).collect();
    let mut joined = kept.join(eol);
    if text.ends_with('\n') {
        joined.push_str(eol);
    }
    Ok(joined)
}

/// The `Game` search paths `with_bots` has and `online` lacks. Install checks that a
/// release's two shipped copies differ by exactly [`BOT_SEARCH_PATHS`].
pub fn added_search_paths(online: &str, with_bots: &str) -> Result<Vec<String>, String> {
    let a = search_paths(online)?;
    let b = search_paths(with_bots)?;
    Ok(b.entries
        .iter()
        .filter(|(_, k, v)| !a.entries.iter().any(|(_, k2, v2)| k.eq_ignore_ascii_case(k2) && v.eq_ignore_ascii_case(v2)))
        .map(|(_, k, v)| format!("{k} {v}"))
        .collect())
}

#[cfg(test)]
pub const ONLINE_SAMPLE: &str = "\"GameInfo\"\r\n{\r\n\tFileSystem\r\n\t{\r\n\t\tSearchPaths\r\n\t\t{\r\n\t\t\tGame_LowViolence\tcsgo_lv // Perfect World content override\r\n\r\n\t\t\tGame\tcsgo\r\n\t\t\tGame\tcore\r\n\r\n\t\t\tMod\t\tcsgo\r\n\t\t}\r\n\t}\r\n\t\"game\" \"SkyOccluder\"\r\n}\r\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabling_bot_mode_adds_only_the_two_search_paths() {
        assert!(!is_bot_mode(ONLINE_SAMPLE).unwrap());
        let on = enable(ONLINE_SAMPLE).unwrap();
        assert!(is_bot_mode(&on).unwrap());
        // Every original line survives, in order, with CRLF endings.
        let kept: Vec<&str> = on.split("\r\n").filter(|l| !l.contains("overrides/botprofile") && !l.contains("addons/metamod")).collect();
        assert_eq!(kept, ONLINE_SAMPLE.split("\r\n").collect::<Vec<_>>());
        assert_eq!(added_search_paths(ONLINE_SAMPLE, &on).unwrap(), ["Game csgo/overrides/botprofile.vpk", "Game csgo/addons/metamod"]);
        assert_eq!(enable(&on).unwrap(), on, "enabling twice changes nothing");
        assert_eq!(disable(&on).unwrap(), ONLINE_SAMPLE, "disabling restores the file exactly");
        assert_eq!(disable(ONLINE_SAMPLE).unwrap(), ONLINE_SAMPLE);
    }

    #[test]
    fn a_bot_path_below_the_base_game_does_not_count_and_is_moved() {
        let late = ONLINE_SAMPLE.replace("\t\t\tGame\tcore\r\n", "\t\t\tGame\tcore\r\n\t\t\tGame\tcsgo/addons/metamod\r\n");
        assert!(!is_bot_mode(&late).unwrap());
        let on = enable(&late).unwrap();
        assert!(is_bot_mode(&on).unwrap());
        assert_eq!(on.matches("csgo/addons/metamod").count(), 1);
    }
}
