//! Starting CS2 in Bot Mode.
//!
//! The game is started through Steam with `steam.exe -applaunch 730 -insecure <options>`.
//! `-insecure` turns VAC off for the session; the mod's README requires it, and Bot Mode
//! never starts the game without it: [`steam_args`] puts it first whatever the options say,
//! and refuses options containing `-secure`.

use super::changes::{self, Meta};
use super::gameinfo;
use super::paths::Layout;
use super::process::{OpLock, ProcessProbe};
use super::settings;
use serde::Serialize;
use super::steam::SteamConfig;

/// Files without which Bot Mode would start an unmodded game: Metamod's loader and
/// CounterStrikeSharp.
const REQUIRED: [&str; 2] = ["addons/metamod.vdf", "addons/counterstrikesharp/bin/win64/counterstrikesharp.dll"];

/// Splits launch options as a command line: whitespace separates, double quotes group.
fn split(options: &str) -> Result<Vec<String>, String> {
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
    if user.iter().any(|a| a.eq_ignore_ascii_case("-secure")) {
        return Err("launch options contain -secure; Bot Mode only starts CS2 with -insecure".into());
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

/// Reads Steam's own CS2 launch options and refuses them when they contain `-secure`: Steam adds
/// them to every start, and `-secure` would turn VAC back on with the mod loaded. Not being able
/// to read them is also a refusal.
fn check_steam_options(steam: &SteamConfig) -> Result<(), String> {
    let opts = steam
        .read_options()
        .map_err(|e| format!("could not read CS2's launch options in Steam, so Bot Mode will not launch: {e}"))?;
    if split(&opts)?.iter().any(|a| a.eq_ignore_ascii_case("-secure")) {
        return Err(format!(
            "CS2's launch options in Steam contain -secure (\"{opts}\"). Steam adds them to every start, which would turn VAC on with the mod loaded. Remove -secure in Steam > Counter-Strike 2 > Properties > Launch options."
        ));
    }
    Ok(())
}

/// Everything before starting the game: CS2 must be closed, Steam's own options must not say
/// `-secure`, the mod must be installed, and Bot Mode on in `gameinfo.gi` (turned on here, with
/// a backup, when it is off). The caller holds `lock` until the game has been handed to Steam.
pub fn prepare(layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig, lock: &OpLock) -> Result<LaunchPlan, String> {
    match probe.cs2_running() {
        Ok(false) => {}
        Ok(true) => return Err("CS2 is already running. Close it, then launch Bot Mode, so the game starts with -insecure.".into()),
        Err(e) => return Err(format!("could not check whether CS2 is running: {e}")),
    }
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

/// Hands the plan to Steam, after checking once more that CS2 has not started meanwhile and
/// reading Steam's CS2 launch options again, since they can change while Bot Mode prepares.
/// Steam starts the game and adds those options.
pub fn start(plan: &LaunchPlan, probe: &dyn ProcessProbe, steam: &SteamConfig) -> Result<(), String> {
    match probe.cs2_running() {
        Ok(false) => {}
        Ok(true) => return Err("CS2 started while Bot Mode was getting ready; it was not launched again.".into()),
        Err(e) => return Err(format!("could not check whether CS2 is running: {e}")),
    }
    check_steam_options(steam)?;
    if plan.args.get(2).map(String::as_str) != Some("-insecure") {
        return Err("internal error: a launch without -insecure was refused".into());
    }
    std::process::Command::new(&plan.steam_exe)
        .args(&plan.args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", plan.steam_exe))
}

/// The whole launch under one operation lock.
pub fn launch(layout: &Layout, probe: &dyn ProcessProbe, steam: &SteamConfig) -> Result<LaunchPlan, String> {
    let lock = OpLock::acquire(layout)?;
    let plan = prepare(layout, probe, steam, &lock)?;
    start(&plan, probe, steam)?;
    Ok(plan)
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
        assert!(steam_args("-novid -SECURE").is_err());
        assert!(steam_args("+exec \"unbalanced").is_err());
    }
}
