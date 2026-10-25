//! Starting CS2 in Bot Mode.
//!
//! The game is started through Steam with `steam.exe -applaunch 730 -insecure <options>`.
//! `-insecure` turns VAC off for the session; the mod's README requires it, and Bot Mode
//! never leaves a modded game running without it:
//! - [`steam_args`] puts `-insecure` first and refuses the app's own options when any token
//!   turns VAC back on (`process::is_secure_token`).
//! - Steam's stored CS2 options get the same check, before and right after preparing.
//! - Steam itself uses the options it holds in memory, which no file read can see, so the
//!   checks above cannot be the last word. After Steam is asked to start the game, Bot Mode
//!   waits for the `cs2.exe` that appears, reads its actual command line, and ends that one
//!   process at once if `-insecure` is missing, a secure-enabling token is present, or the
//!   command line cannot be read. That check is on the running game itself, so it closes the
//!   gap left by every earlier check, whatever Steam added.

use super::changes::{self, Meta};
use super::gameinfo;
use super::paths::Layout;
use super::process::{self, is_secure_token, OpLock, Phase, ProcessProbe};
use super::settings;
use super::steam::SteamConfig;
use serde::Serialize;
use std::time::{Duration, Instant};

/// Files without which Bot Mode would start an unmodded game: Metamod's loader and
/// CounterStrikeSharp.
const REQUIRED: [&str; 2] = ["addons/metamod.vdf", "addons/counterstrikesharp/bin/win64/counterstrikesharp.dll"];

/// How long to wait for CS2 to appear after Steam is asked to start it. Steam can take a while
/// when it first has to validate or update; after this the launch reports that it could not
/// confirm `-insecure` rather than wait without end.
const START_WAIT: Duration = Duration::from_secs(60);

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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub steam_exe: String,
    pub args: Vec<String>,
    /// The change that turned Bot Mode on in `gameinfo.gi`, when it was off.
    pub bot_mode_change: Option<Meta>,
}

/// What the check on the started game found.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchReport {
    #[serde(flatten)]
    pub plan: LaunchPlan,
    /// The `cs2.exe` this launch started, when it appeared in time.
    pub pid: Option<u32>,
    /// Its command line, when read.
    pub command_line: Option<String>,
    /// Set when CS2 did not appear within the wait, so `-insecure` is unconfirmed.
    pub warning: Option<String>,
}

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
/// Steam's own options must not turn VAC on, the mod must be installed, and Bot Mode on in
/// `gameinfo.gi` (turned on here, with a backup, when it is off). The caller holds `lock`
/// until the game has been handed to Steam.
pub fn prepare(layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig, lock: &OpLock) -> Result<LaunchPlan, String> {
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
    let bot_mode_change = if gameinfo::is_bot_mode(&text)? {
        None
    } else {
        let on = gameinfo::enable(&text)?;
        Some(changes::run(layout, probe, lock, "bot-mode-on", |cs| cs.put_bytes("gameinfo.gi", on.as_bytes()))?.1)
    };
    let steam_exe = steam.steam.join("steam.exe");
    if !steam_exe.is_file() {
        return Err(format!("{} not found", steam_exe.display()));
    }
    Ok(LaunchPlan { steam_exe: steam_exe.display().to_string(), args, bot_mode_change })
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

/// Hands the plan to Steam, then checks the `cs2.exe` it starts (see the module notes).
pub fn start(plan: LaunchPlan, layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig) -> Result<LaunchReport, String> {
    check_start(&plan, layout, probe, steam)?;
    let before = process::cs2_pids()?;
    std::process::Command::new(&plan.steam_exe)
        .args(&plan.args)
        .spawn()
        .map_err(|e| format!("{}: {e}", plan.steam_exe))?;
    let deadline = Instant::now() + START_WAIT;
    let pid = loop {
        if let Some(pid) = process::new_process(&before, &process::cs2_pids()?)? {
            break pid;
        }
        if Instant::now() >= deadline {
            return Ok(LaunchReport {
                plan,
                pid: None,
                command_line: None,
                warning: Some(format!(
                    "CS2 did not start within {} seconds, so its -insecure could not be confirmed. If it starts later, check its launch options before playing.",
                    START_WAIT.as_secs()
                )),
            });
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let line = process::command_line(pid).ok();
    if let Err(why) = process::judge_command_line(line.as_deref()) {
        let ended = match process::terminate(pid) {
            Ok(()) => "it was ended at once".to_string(),
            Err(e) => format!("ending it failed ({e}); close CS2 now"),
        };
        return Err(format!("CS2 (process {pid}) started without VAC safely off: {why}; {ended}."));
    }
    Ok(LaunchReport { plan, pid: Some(pid), command_line: line, warning: None })
}

/// The whole launch under one operation lock.
pub fn launch(layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig) -> Result<LaunchReport, String> {
    let lock = OpLock::acquire(layout)?;
    let plan = prepare(layout, probe, steam, &lock)?;
    start(plan, layout, probe, steam)
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
