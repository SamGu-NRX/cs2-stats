//! `cs2-stats botmode <command>`: the Bot Mode operations without the window.

use super::process::SystemProbe;
use super::settings::{self, Difficulty};
use super::{changes, install, launch, monitor, overlay, session, status, Ctx, Game};
use serde::Serialize;
use std::path::PathBuf;

const USAGE: &str = "\
usage: cs2-stats botmode <command> [options]

  status                     Read-only report: CS2 folder, mod version, component hashes,
                             protected files, settings, backups.
  releases                   List the mod's releases on GitHub.
  download <tag>             Download and verify a release into the app folder only.
  install <tag>              Install a release (downloads it first when needed).
  overlay                    Copy the builds listed in the overlay manifest over the release.
  init-manifest              Write the example overlay manifest, if there is none yet.
  rollback [id]              Undo the newest change (or name it).
  backups                    List recorded changes.
  launch                     Start a Bot Mode session: CS2 through Steam, always with -insecure,
                             watched until it exits; Bot Mode is on only for that session.
  set difficulty low|medium|high
  set knife-skins 0|1
  set knife-premium 0|1
  set music-kit <id>         0 off, -1 random per map, or a kit id from BotRandomizer's catalog
  set launch-options \"<options>\"

options:
  --game <dir>       The game\\csgo folder, instead of finding it through Steam.
  --data <dir>       The app's Bot Mode folder (default %APPDATA%\\BotMatchStats\\botmode).
  --manifest <file>  Overlay manifest (default <data>\\overlay.json).
  --asset <name>     Release asset (default CS2BotImprover.zip).
  --sha256 <hex>     Expected hash, for an asset GitHub publishes no digest for.
  --json             Print JSON instead of text.

Install, overlay, rollback, set and launch refuse while cs2.exe is running.";

struct Args {
    words: Vec<String>,
    game: Option<PathBuf>,
    /// Debug builds only: a scratch game folder that skips the CS2 folder identity check.
    unchecked_game: Option<PathBuf>,
    data: Option<PathBuf>,
    manifest: Option<PathBuf>,
    asset: Option<String>,
    sha256: Option<String>,
    json: bool,
    /// `supervise-session` only.
    mode: Option<String>,
    run: Option<String>,
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args { words: Vec::new(), game: None, unchecked_game: None, data: None, manifest: None, asset: None, sha256: None, json: false, mode: None, run: None };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let mut value = |flag: &str| it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match arg.as_str() {
            "--game" => a.game = Some(value(arg)?.into()),
            #[cfg(debug_assertions)]
            "--unchecked-game-folder-for-testing" => a.unchecked_game = Some(value(arg)?.into()),
            "--data" => a.data = Some(value(arg)?.into()),
            "--manifest" => a.manifest = Some(value(arg)?.into()),
            "--asset" => a.asset = Some(value(arg)?),
            "--sha256" => a.sha256 = Some(value(arg)?),
            "--json" => a.json = true,
            "--mode" => a.mode = Some(value(arg)?),
            "--run" => a.run = Some(value(arg)?),
            s if s.starts_with("--") => return Err(format!("unknown option {s}")),
            s => a.words.push(s.to_string()),
        }
    }
    Ok(a)
}

fn print<T: Serialize>(json: bool, value: &T, text: impl FnOnce(&T) -> String) {
    if json {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|e| format!("{{\"error\": \"{e}\"}}")));
    } else {
        print!("{}", text(value));
    }
}

fn meta_line(m: &changes::Meta) -> String {
    let mut o = if m.files == 0 {
        "No files changed.\n".to_string()
    } else {
        format!("Change {}: {} file(s) written, backed up first. Undo with `botmode rollback`.\n", m.id, m.files)
    };
    for w in &m.warnings {
        o.push_str(&format!("warning: {w}\n"));
    }
    o
}

/// Starts a supervisor that adopts a CS2 running with Bot Mode on (see `session::cleanup`).
fn start_adopter(layout: &super::paths::Layout) -> Result<(), String> {
    session::start_and_wait(layout, &monitor::Windows, session::RunMode::Adopt).map(|_| ())
}

/// The hidden `supervise-session` command: the supervisor process itself. It has no console;
/// everything it reports goes to the status file.
fn supervise_session(a: &Args, ctx: &Ctx, probe: &SystemProbe) -> i32 {
    // A panic must end this process at once, in every build, so its lease is freed.
    std::panic::set_hook(Box::new(|info| {
        eprintln!("{info}");
        std::process::abort();
    }));
    let Some(mode) = a.mode.as_deref().map(session::RunMode::parse) else { return 2 };
    let Ok(mode) = mode else { return 2 };
    let run_id = a.run.clone().unwrap_or_else(session::new_run_id);
    let steam = ctx.steam_config();
    let status = session::supervise_session(&ctx.layout, probe, &monitor::Windows, steam.as_ref().ok(), mode, &run_id, &launch::spawn_steam);
    if status.state == "done" && status.left_on.is_none() {
        0
    } else {
        1
    }
}

fn run(a: Args) -> Result<(), String> {
    let words: Vec<&str> = a.words.iter().map(String::as_str).collect();
    let probe = SystemProbe;
    let asset = a.asset.as_deref().unwrap_or(install::DEFAULT_ASSET);
    // Listing releases needs no game folder.
    if words.as_slice() == ["releases"] {
        let rels = super::github::releases(install::OFFICIAL_REPO)?;
        print(a.json, &rels, |rels| {
            let mut o = String::new();
            for r in rels.iter().filter(|r| !r.draft) {
                let assets: Vec<_> = r.assets.iter().map(|x| x.name.as_str()).collect();
                o.push_str(&format!("{:<10}{}  {}\n", r.tag_name, r.published_at.as_deref().unwrap_or(""), assets.join(", ")));
            }
            o
        });
        return Ok(());
    }
    let game = match (a.game.clone(), a.unchecked_game.clone()) {
        (Some(_), Some(_)) => return Err("give --game or the testing override, not both".into()),
        (Some(g), None) => Game::Folder(g),
        #[cfg(debug_assertions)]
        (None, Some(g)) => Game::UncheckedForTesting(g),
        _ => Game::Steam,
    };
    let ctx = Ctx::new(game, a.data.clone())?;
    let layout = &ctx.layout;
    if words.as_slice() == ["supervise-session"] {
        return match supervise_session(&a, &ctx, &probe) {
            0 => Ok(()),
            _ => Err(format!("the Bot Mode session did not end cleanly; see {}", session::status_path(layout).display())),
        };
    }
    if !matches!(words.as_slice(), ["status"] | ["rollback"] | ["rollback", _] | ["backups"]) {
        if let Some(m) = changes::unfinished(layout)? {
            eprintln!("warning: change {} ({}) is unfinished; run `botmode rollback` before anything else.", m.id, m.operation);
        }
    }
    // Bot Mode left on with no supervisor is dealt with before anything that changes game
    // files, and those commands wait while a session runs. Read-only commands only report it.
    let writes = matches!(words.first().copied(), Some("install" | "overlay" | "rollback" | "set" | "launch"));
    if writes {
        if let Some(notice) = session::guard(layout, &probe, &monitor::Windows, &|| start_adopter(layout))? {
            eprintln!("{notice}");
        }
    }
    match words.as_slice() {
        ["init-manifest"] => {
            let path = a.manifest.clone().unwrap_or_else(|| layout.default_manifest());
            overlay::init_manifest(layout, &path)?;
            println!("Wrote {}. Check each entry's checkout, branch and build folder.", path.display());
        }
        ["status"] => {
            let s = status::status(layout, &probe, ctx.install.as_ref(), ctx.steam_launch_options())?;
            print(a.json, &s, status::render);
        }
        ["download", tag] => {
            let c = install::download(layout, tag, asset, a.sha256.as_deref())?;
            print(a.json, &c.index, |i| {
                format!("{} {}: {} files, SHA-256 {} verified.\nSaved to {}\nSource: {}\n", i.tag, i.asset, i.files.len(), i.sha256, c.zip.display(), i.source.url)
            });
        }
        ["install", tag] => {
            let cached = match install::cached(layout, tag, asset) {
                Some(c) => c,
                None => install::download(layout, tag, asset, a.sha256.as_deref())?,
            };
            let r = install::install(layout, &probe, &cached)?;
            print(a.json, &r, |r| {
                let s = &r.summary;
                let mut o = format!("Installed {} ({}): {} file(s) written, {} already current.\n", s.tag, s.asset, s.written, s.unchanged);
                o.push_str(&meta_line(&r.change));
                o.push_str(&format!("Source: {}\n", s.source.url));
                for k in &s.skipped {
                    o.push_str(&format!("Skipped {}: {}\n", k.path, k.reason));
                }
                for k in &s.kept {
                    o.push_str(&format!("Kept your {k} (protected)\n"));
                }
                for k in &s.user_values_kept {
                    o.push_str(&format!("Kept your own convar values in {k}\n"));
                }
                for k in &s.merged {
                    o.push_str(&format!("Merged missing convars into your {k}\n"));
                }
                if let Some(d) = s.difficulty_kept {
                    o.push_str(&format!("Kept difficulty {}.\n", d.name()));
                }
                if !s.overlays_replaced.is_empty() {
                    o.push_str(&format!("The release replaced overlay(s) {}. Run `botmode overlay` to put them back.\n", s.overlays_replaced.join(", ")));
                }
                o
            });
        }
        ["overlay"] => {
            let manifest = a.manifest.clone().unwrap_or_else(|| layout.default_manifest());
            let r = overlay::apply(layout, &probe, &manifest)?;
            print(a.json, &r, |r| {
                let mut o = format!("Overlay from {}\n", r.manifest);
                for e in &r.entries {
                    o.push_str(&format!("  {:<16}{} of {} file(s) written  source {}\n", e.name, e.written, e.files, e.source.url));
                    for w in &e.warnings {
                        o.push_str(&format!("    warning: {w}\n"));
                    }
                }
                o.push_str(&meta_line(&r.change));
                o
            });
        }
        ["rollback"] | ["rollback", _] => {
            let r = changes::rollback(layout, &probe, words.get(1).copied())?;
            print(a.json, &r, |r| {
                let mut o = format!("Rolled back {} ({}): {} restored, {} removed, {} already as before.\n", r.id, r.operation, r.restored, r.removed, r.unchanged);
                for w in &r.warnings {
                    o.push_str(&format!("warning: {w}\n"));
                }
                o
            });
        }
        ["backups"] => {
            let list = changes::list(layout)?;
            print(a.json, &list, |list| {
                if list.is_empty() {
                    return "No changes recorded.\n".into();
                }
                list.iter().map(|m| format!("{}  {:?}  {} file(s)  {}\n", m.id, m.status, m.files, m.created)).collect()
            });
        }
        ["launch"] => {
            let run_id = session::start_and_wait(layout, &monitor::Windows, session::RunMode::Launch)?;
            if !a.json {
                println!("Bot Mode is on only for this session: a supervisor turns it on, starts CS2 through Steam, watches CS2 until it exits, and turns Bot Mode off.");
                println!("Closing this window or pressing Ctrl+C stops only this view; the session keeps running.");
                eprintln!("{}", session::UNPROTECTED);
            }
            let status = session::follow(layout, &monitor::Windows, &run_id, &|_| false, &|s| {
                if !a.json {
                    eprintln!("{}", s.message);
                }
            })?;
            if status.state == "failed" {
                // A supervisor that died is cleaned up at once.
                if let Some(notice) = session::cleanup_message(&session::cleanup(layout, &probe, &monitor::Windows, &|| start_adopter(layout))) {
                    eprintln!("{notice}");
                }
            }
            if a.json {
                print(true, &status, |_| String::new());
            }
            for m in status.bot_mode_on.iter().chain(status.bot_mode_off.iter()) {
                for w in &m.warnings {
                    eprintln!("warning: {w}");
                }
            }
            let unsafe_seen = status.outcome.as_ref().is_some_and(|o| o.had_unsafe());
            let no_start = matches!(status.outcome, Some(monitor::Outcome::NoStart { .. }));
            if status.state != "done" || unsafe_seen || no_start || status.left_on.is_some() {
                return Err(status.message);
            }
        }
        ["set", "difficulty", level] => {
            let m = settings::set_difficulty(layout, &probe, Difficulty::parse(level)?)?;
            print(a.json, &m, meta_line);
        }
        ["set", key @ ("knife-skins" | "knife-premium" | "music-kit"), value] => {
            let mut c = settings::read_cosmetics(&layout.csgo)?.cosmetics;
            let flag = |v: &str| match v {
                "0" => Ok(false),
                "1" => Ok(true),
                _ => Err(format!("{key} is 0 or 1")),
            };
            match *key {
                "knife-skins" => c.dropped_knife_skins = flag(value)?,
                "knife-premium" => c.dropped_knife_premium = flag(value)?,
                _ => c.music_kit = value.parse().map_err(|_| format!("{value}: music-kit is a number"))?,
            }
            let m = settings::set_cosmetics(layout, &probe, c)?;
            print(a.json, &m, meta_line);
        }
        ["set", "launch-options", options] => {
            let mut s = settings::load_app(layout)?;
            s.launch_options = options.to_string();
            settings::save_app(layout, &s)?;
            println!("Bot Mode will start CS2 with: -insecure {options}");
        }
        _ => return Err(format!("unknown command: {}\n\n{USAGE}", words.join(" "))),
    }
    Ok(())
}

/// Entry point from `main`, given the arguments after `botmode`. Returns the exit code.
pub fn main(argv: &[String]) -> i32 {
    attach_console();
    if argv.is_empty() || argv.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return if argv.is_empty() { 2 } else { 0 };
    }
    match parse(argv).and_then(run) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

/// Release builds are Windows GUI programs with no console. When started from a terminal
/// with nothing redirected, attach to that terminal so the report is visible.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
    // SAFETY: querying and attaching the process's standard handles has no preconditions.
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_line_shows_its_durability_warnings() {
        let meta = changes::Meta {
            seq: 1,
            id: "0001-x-bot-mode-on".into(),
            operation: "bot-mode-on".into(),
            created: String::new(),
            status: changes::Status::Complete,
            files: 1,
            error: None,
            warnings: vec!["Windows would not flush folder X".into()],
            kind: changes::Kind::Normal,
        };
        let line = meta_line(&meta);
        assert!(line.contains("0001-x-bot-mode-on") && line.contains("warning: Windows would not flush folder X"), "{line}");
    }
}
