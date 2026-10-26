//! Starting CS2 in Bot Mode.
//!
//! The game is started through Steam with `steam.exe -applaunch 730 -insecure <options>`.
//! `-insecure` turns VAC off for the session; the mod's README requires it, and Bot Mode
//! never leaves a modded game running without it:
//! - [`steam_args`] puts `-insecure` first and refuses the app's own options when any token
//!   turns VAC back on (`process::is_secure_token`).
//! - Steam's stored CS2 options get the same check, before and right after preparing.
//! - Steam itself uses the options it holds in memory, which no file read can see, so the
//!   checks above cannot be the last word. Bot Mode is on only for a supervised session
//!   (`session.rs`): it is turned on right before Steam is asked to start the game, every new
//!   `cs2.exe` of this install is checked for the whole session (`monitor.rs`) and the unsafe
//!   ones ended, and it is turned off when CS2 exits. That check is on the running game
//!   itself, so it closes the gap left by every earlier check, whatever Steam added. The one
//!   case it cannot cover is in `session.rs`: the app crashes mid-session and CS2 is then
//!   started from Steam before Bot Mode runs again.

use super::changes;
use super::gameinfo;
use super::paths::Layout;
use super::process::{is_secure_token, OpLock, Phase, ProcessProbe};
use super::settings;
use super::steam::SteamConfig;
use serde::Serialize;

/// Files without which Bot Mode would start an unmodded game: Metamod's loader and
/// CounterStrikeSharp.
const REQUIRED: [&str; 2] = ["addons/metamod.vdf", "addons/counterstrikesharp/bin/win64/counterstrikesharp.dll"];

/// Splits launch options as a command line: whitespace separates, double quotes group.
pub fn split(options: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in options.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if quoted {
        return Err(format!("{options}: unbalanced quote"));
    }
    if any {
        out.push(cur);
    }
    Ok(out)
}

/// Arguments for `steam.exe`: `-applaunch 730 -insecure`, then the user's options.
pub fn steam_args(options: &str) -> Result<Vec<String>, String> {
    let user = split(options)?;
    if let Some(t) = user.iter().find(|a| is_secure_token(a)) {
        return Err(format!("launch options contain {t}, which turns VAC on; Bot Mode only starts CS2 with -insecure"));
    }
    let mut args: Vec<String> = ["-applaunch", super::steam::CS2_APP_ID, "-insecure"].map(String::from).to_vec();
    args.extend(user.into_iter().filter(|a| !a.eq_ignore_ascii_case("-insecure")));
    Ok(args)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub steam_exe: String,
    pub args: Vec<String>,
}

/// What the check on the started game found.
/// Reads Steam's own CS2 launch options and refuses them when any token turns VAC back on:
/// Steam adds them to every start. Not being able to read them is also a refusal.
fn check_steam_options(steam: &SteamConfig) -> Result<(), String> {
    let opts = steam
        .read_options()
        .map_err(|e| format!("could not read CS2's launch options in Steam, so Bot Mode will not launch: {e}"))?;
    if let Some(t) = split(&opts)?.iter().find(|a| is_secure_token(a)) {
        return Err(format!(
            "CS2's launch options in Steam contain {t} (\"{opts}\"). Steam adds them to every start, which would turn VAC on with the mod loaded. Remove it in Steam > Counter-Strike 2 > Properties > Launch options."
        ));
    }
    Ok(())
}

/// An interrupted or partly undone change leaves the game folder half-written; never start the
/// game on top of one.
fn check_no_unfinished(layout: &Layout) -> Result<(), String> {
    match changes::unfinished(layout)? {
        Some(m) => Err(format!(
            "change {} ({}) is unfinished, so the game folder may be half-written; run `botmode rollback` first",
            m.id, m.operation
        )),
        None => Ok(()),
    }
}

fn check_closed(probe: &dyn ProcessProbe, phase: Phase, running: &str) -> Result<(), String> {
    match probe.cs2_running(phase) {
        Ok(false) => Ok(()),
        Ok(true) => Err(running.into()),
        Err(e) => Err(format!("could not check whether CS2 is running: {e}")),
    }
}

/// Everything before starting the game: CS2 must be closed, no change may be unfinished,
/// Steam's own options must not turn VAC on, the mod must be installed, and `gameinfo.gi`
/// must be readable. Turning Bot Mode on is the session's job (`session::begin`), right before
/// the spawn. The caller holds `lock` until the game has been handed to Steam.
pub fn prepare(layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig, _lock: &OpLock) -> Result<LaunchPlan, String> {
    check_closed(probe, Phase::LaunchPrepare, "CS2 is already running. Close it, then launch Bot Mode, so the game starts with -insecure.")?;
    check_no_unfinished(layout)?;
    check_steam_options(steam)?;
    let mut missing = Vec::new();
    for r in REQUIRED {
        if !layout.confined(r)?.is_file() {
            missing.push(r);
        }
    }
    if !missing.is_empty() {
        return Err(format!("the mod is not installed ({} missing); run `botmode install <tag>` first", missing.join(", ")));
    }
    let args = steam_args(&settings::load_app(layout)?.launch_options)?;
    let gi_path = layout.confined("gameinfo.gi")?;
    let text = std::fs::read_to_string(&gi_path).map_err(|e| format!("{}: {e}", gi_path.display()))?;
    gameinfo::enable(&text)?;
    let steam_exe = steam.steam.join("steam.exe");
    if !steam_exe.is_file() {
        return Err(format!("{} not found", steam_exe.display()));
    }
    Ok(LaunchPlan { steam_exe: steam_exe.display().to_string(), args })
}

/// The last checks before Steam is asked to start the game: CS2 has not started meanwhile, no
/// change is unfinished, and Steam's stored options (read again, since they can change while
/// Bot Mode prepares) do not turn VAC on.
pub fn check_start(plan: &LaunchPlan, layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig) -> Result<(), String> {
    check_closed(probe, Phase::LaunchStart, "CS2 started while Bot Mode was getting ready; it was not launched again.")?;
    check_no_unfinished(layout)?;
    check_steam_options(steam)?;
    if plan.args.get(2).map(String::as_str) != Some("-insecure") {
        return Err("internal error: a launch without -insecure was refused".into());
    }
    Ok(())
}

/// Asks Steam to start the game with the plan's arguments.
pub fn spawn_steam(plan: &LaunchPlan) -> Result<(), String> {
    if plan.args.get(2).map(String::as_str) != Some("-insecure") {
        return Err("internal error: a launch without -insecure was refused".into());
    }
    std::process::Command::new(&plan.steam_exe)
        .args(&plan.args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", plan.steam_exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_launch_carries_insecure_and_the_users_options() {
        assert_eq!(steam_args("").unwrap(), ["-applaunch", "730", "-insecure"]);
        assert_eq!(
            steam_args("-novid +exec \"my autoexec\" -insecure").unwrap(),
            ["-applaunch", "730", "-insecure", "-novid", "+exec", "my autoexec"]
        );
    }

    #[test]
    fn options_that_would_turn_vac_back_on_are_refused() {
        for bad in ["-novid -secure", "+secure", "--secure", "-secure=1", "-SECURE", "-novid \"-secure\"", "\"-secure 1\""] {
            assert!(steam_args(bad).is_err(), "{bad}");
        }
        assert!(steam_args("+exec \"unbalanced").is_err());
    }
}
