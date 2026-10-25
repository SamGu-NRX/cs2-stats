//! Mod components: which known files under `game\csgo` belong to which part of the mod.
//!
//! A component is a set of files the mod ships: Metamod, CounterStrikeSharp, each Metamod
//! plugin (with its CounterStrikeSharp half), each CounterStrikeSharp plugin folder, the
//! mod's cfgs, the bot profiles and the two `gameinfo.gi` copies in `backup\`. Runtime
//! output (logs, recordings) and plugin-written configs are not part of any component.

use super::hash;
use super::paths::{self, Protection};
use std::collections::BTreeMap;
use std::path::Path;

/// The cfgs in the v1.4.7 Windows zip. Other files in `cfg\` are Valve's or the user's.
const MOD_CFGS: [&str; 18] = [
    "bot_buy.cfg",
    "gamemode_armsrace.cfg",
    "gamemode_casual.cfg",
    "gamemode_competitive.cfg",
    "gamemode_competitive2v2.cfg",
    "gamemode_competitive2v2_offline.cfg",
    "gamemode_competitive_offline.cfg",
    "gamemode_custom.cfg",
    "gamemode_deathmatch.cfg",
    "gamemode_dm_freeforall.cfg",
    "gamemode_retakecasual.cfg",
    "gamemode_rush.cfg",
    "gamemode_rush_offline.cfg",
    "gamemode_teamdeathmatch.cfg",
    "gamemode_workshop.cfg",
    "my_bot_ffa_config.cfg",
    "my_bot_normal_config.cfg",
    "my_bot_rush_config.cfg",
];

/// Metamod plugins whose CounterStrikeSharp half lives in `plugins\<Name>Impl`.
const METAMOD_PLUGINS: [&str; 3] = ["BotController", "BotHider", "BotVision"];

pub const METAMOD: &str = "Metamod:Source";
pub const CSSHARP: &str = "CounterStrikeSharp";
pub const CFGS: &str = "Mod cfgs";
pub const PROFILES: &str = "Bot profiles";
pub const MODE_BACKUPS: &str = "Mode backups (backup/)";

/// The component a game path belongs to, or `None` for files outside the mod.
pub fn owner(rel: &str) -> Option<String> {
    if paths::protection(rel) != Protection::None || paths::is_runtime_output(rel) {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').collect();
    let lower: Vec<String> = parts.iter().map(|p| p.to_ascii_lowercase()).collect();
    let l: Vec<&str> = lower.iter().map(String::as_str).collect();
    let named = |n: &str| Some(n.to_string());
    match l.as_slice() {
        ["addons", "metamod.vdf"] | ["addons", "metamod_x64.vdf"] => named(METAMOD),
        ["addons", "metamod", vdf] if vdf.ends_with(".vdf") => {
            let stem = &parts[2][..parts[2].len() - 4];
            if let Some(p) = METAMOD_PLUGINS.iter().find(|p| p.eq_ignore_ascii_case(stem)) {
                named(p)
            } else if stem.eq_ignore_ascii_case("counterstrikesharp") {
                named(CSSHARP)
            } else {
                named(METAMOD)
            }
        }
        ["addons", "metamod", ..] => named(METAMOD),
        ["addons", "counterstrikesharp", "plugins", _file] => named(CSSHARP),
        ["addons", "counterstrikesharp", "plugins", _, ..] => {
            let dir = parts[3];
            match METAMOD_PLUGINS.iter().find(|p| format!("{p}impl").eq_ignore_ascii_case(dir)) {
                Some(p) => named(p),
                None => named(dir),
            }
        }
        // Plugins write their own settings here on first load; the mod ships only the README.
        ["addons", "counterstrikesharp", "configs", "plugins", _file] => named(CSSHARP),
        ["addons", "counterstrikesharp", "configs", "plugins", ..] => None,
        ["addons", "counterstrikesharp", ..] => named(CSSHARP),
        ["addons", dir, _, ..] => METAMOD_PLUGINS
            .iter()
            .find(|p| p.eq_ignore_ascii_case(dir))
            .map(|p| p.to_string())
            .or_else(|| named(parts[1])),
        ["cfg", name] if MOD_CFGS.contains(name) => named(CFGS),
        ["overrides", ..] => named(PROFILES),
        ["backup", "online", "gameinfo.gi"] | ["backup", "withbots", "gameinfo.gi"] => named(MODE_BACKUPS),
        _ => None,
    }
}

/// Hashes every component file present under `csgo`, grouped by component.
pub fn scan(csgo: &Path) -> Result<BTreeMap<String, BTreeMap<String, String>>, String> {
    let mut found = Vec::new();
    for top in ["addons", "cfg", "overrides", "backup"] {
        paths::walk_files(csgo, &csgo.join(top), &mut found)?;
    }
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for rel in found {
        if let Some(name) = owner(&rel) {
            let digest = hash::file(&paths::join_rel(csgo, &rel))?;
            out.entry(name).or_default().insert(rel, digest);
        }
    }
    Ok(out)
}

/// Protected user files present under `csgo`, with their hashes.
pub fn protected(csgo: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut found = Vec::new();
    paths::walk_files(csgo, &csgo.join("cfg"), &mut found)?;
    paths::walk_files(csgo, &csgo.join("addons").join("metamod").join("animation"), &mut found)?;
    let mut out = BTreeMap::new();
    for rel in found {
        if paths::protection(&rel) != Protection::None {
            out.insert(rel.clone(), hash::file(&paths::join_rel(csgo, &rel))?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_grouped_into_the_component_that_ships_them() {
        let cases = [
            ("addons/metamod_x64.vdf", Some(METAMOD)),
            ("addons/metamod/bin/metamod.2.csgo.dll", Some(METAMOD)),
            ("addons/metamod/BotHider.vdf", Some("BotHider")),
            ("addons/metamod/counterstrikesharp.vdf", Some(CSSHARP)),
            ("addons/BotHider/bin/win64/BotHider.dll", Some("BotHider")),
            ("addons/counterstrikesharp/plugins/BotHiderImpl/BotHiderImpl.dll", Some("BotHider")),
            ("addons/counterstrikesharp/plugins/BotState/BotState.dll", Some("BotState")),
            ("addons/counterstrikesharp/plugins/README.txt", Some(CSSHARP)),
            ("addons/counterstrikesharp/dotnet/host/fxr/10.0.0/hostfxr.dll", Some(CSSHARP)),
            ("cfg/my_bot_normal_config.cfg", Some(CFGS)),
            ("overrides/High/botprofile.vpk", Some(PROFILES)),
            ("backup/WithBots/gameinfo.gi", Some(MODE_BACKUPS)),
            // Not part of any component:
            ("addons/counterstrikesharp/configs/plugins/BotRandomizer/BotRandomizer.json", None),
            ("addons/BotHider/logs/BotHider_2026-10-25.log", None),
            ("addons/counterstrikesharp/plugins/BotControllerImpl/recordings/r1.bin", None),
            ("addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c", None),
            ("cfg/autoexec.cfg", None),
            ("cfg/server.cfg", None),
        ];
        for (rel, want) in cases {
            assert_eq!(owner(rel).as_deref(), want, "{rel}");
        }
    }
}
