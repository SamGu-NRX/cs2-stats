//! `cs2-stats botmode <command>`: the Bot Mode operations without the window.

use super::process::SystemProbe;
use super::settings::{self, Difficulty};
use super::{changes, install, launch, overlay, status, Ctx, Game};
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
  launch                     Start CS2 in Bot Mode through Steam, always with -insecure.
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
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args { words: Vec::new(), game: None, unchecked_game: None, data: None, manifest: None, asset: None, sha256: None, json: false };
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
    if !matches!(words.as_slice(), ["status"] | ["rollback"] | ["rollback", _] | ["backups"]) {
        if let Some(m) = changes::unfinished(layout)? {
            eprintln!("warning: change {} ({}) is unfinished; run `botmode rollback` before anything else.", m.id, m.operation);
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
                if s.bot_mode_enabled {
                    o.push_str("Turned Bot Mode on in gameinfo.gi.\n");
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
            let report = launch::launch(layout, &probe, &ctx.steam_config()?)?;
            print(a.json, &report, |r| {
                let mut o = String::new();
                if let Some(m) = &r.plan.bot_mode_change {
                    o.push_str(&format!("Turned Bot Mode on in gameinfo.gi (change {}).\n", m.id));
                }
                o.push_str(&format!("Started: \"{}\" {}\n", r.plan.steam_exe, r.plan.args.join(" ")));
                match (r.pid, &r.warning) {
                    (Some(pid), _) => o.push_str(&format!("CS2 is running as process {pid} with -insecure confirmed on its command line.\n")),
                    (None, Some(w)) => o.push_str(&format!("warning: {w}\n")),
                    (None, None) => {}
                }
                o
            });
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
