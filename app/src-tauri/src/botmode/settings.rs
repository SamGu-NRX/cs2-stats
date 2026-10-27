//! Bot difficulty, the player's BotRandomizer cosmetics, and the app's own launch options.
//!
//! Difficulty is the mod's documented mechanism (README, "How to manually change the
//! difficulty level?"): copy `overrides\<Low|Medium|High>\botprofile.vpk` over
//! `overrides\botprofile.vpk`. The cosmetics are three BotRandomizer convars, merged into
//! `cfg\gamemode_competitive_server.cfg`, which runs after the mod's cfgs and which game and
//! mod updates do not ship. The same cfg takes the mod's `bot_aim` and `bot_nades` presets
//! (its BotAimImprover and NadeSystem READMEs list the values) and this app's knife-drop bind
//! (see [`KnifeBind`]).

use super::cfg;
use super::changes::{self, write_atomic, Meta};
use super::hash;
use super::paths::{confined_read, Layout, SERVER_CFG};
use super::process::{ensure_cs2_closed, OpLock, Phase, ProcessProbe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Difficulty {
    Low,
    Medium,
    High,
}

pub const ACTIVE_PROFILE: &str = "overrides/botprofile.vpk";

impl Difficulty {
    pub const ALL: [Difficulty; 3] = [Difficulty::Low, Difficulty::Medium, Difficulty::High];

    /// The release's copy of this level's bot profile.
    pub fn variant(self) -> &'static str {
        match self {
            Difficulty::Low => "overrides/Low/botprofile.vpk",
            Difficulty::Medium => "overrides/Medium/botprofile.vpk",
            Difficulty::High => "overrides/High/botprofile.vpk",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Difficulty::Low => "low",
            Difficulty::Medium => "medium",
            Difficulty::High => "high",
        }
    }

    pub fn parse(s: &str) -> Result<Difficulty, String> {
        Difficulty::ALL
            .into_iter()
            .find(|d| d.name().eq_ignore_ascii_case(s))
            .ok_or_else(|| format!("{s}: difficulty is low, medium or high"))
    }
}

/// The active level, found by matching the active bot profile against the three shipped
/// copies. `None` when the active profile matches none of them, or there is none.
pub fn current_difficulty(csgo: &Path) -> Result<Option<Difficulty>, String> {
    let Some(active) = hash::file_if_exists(&confined_read(csgo, ACTIVE_PROFILE)?)? else { return Ok(None) };
    for d in Difficulty::ALL {
        if hash::file_if_exists(&confined_read(csgo, d.variant())?)?.as_deref() == Some(active.as_str()) {
            return Ok(Some(d));
        }
    }
    Ok(None)
}

pub fn set_difficulty(layout: &Layout, probe: &dyn ProcessProbe, level: Difficulty) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let src = layout.confined(level.variant())?;
    let sha = hash::file_if_exists(&src)?
        .ok_or_else(|| format!("{} is missing; install the mod first", level.variant()))?;
    let (_, meta) = changes::run(layout, probe, &lock, &format!("difficulty-{}", level.name()), |cs| {
        cs.put_file(ACTIVE_PROFILE, &src, &sha)
    })?;
    Ok(meta)
}

/// The BotRandomizer convars for the human player. They come from the user's
/// BotRandomizer fork; an official build prints "Unknown command" for them.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cosmetics {
    /// `br_dropped_knife_skins`: random finishes on knives spawned with `subclass_create`.
    pub dropped_knife_skins: bool,
    /// `br_dropped_knife_premium`: favour expensive finishes on those knives.
    pub dropped_knife_premium: bool,
    /// `br_player_music_kit`: 0 off, -1 one random kit per map, otherwise a kit id.
    pub music_kit: i32,
}

pub const COSMETIC_CONVARS: [&str; 3] = ["br_dropped_knife_skins", "br_dropped_knife_premium", "br_player_music_kit"];
const CATALOG: &str = "addons/counterstrikesharp/plugins/BotRandomizer/cosmetic_catalog.json";
const NEW_CFG_HEADER: &str = "// Local settings, run by CS2 on every competitive map load, after the mod's cfgs.\r\n// Valve and the mod do not ship this file, so updates leave it alone.\r\n";

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CosmeticsState {
    #[serde(flatten)]
    pub cosmetics: Cosmetics,
    /// Whether the cfg exists. Missing values read as the plugin's defaults.
    pub cfg_present: bool,
}

fn parse_bool(v: &str) -> Option<bool> {
    match v.to_ascii_lowercase().as_str() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

pub fn read_cosmetics(csgo: &Path) -> Result<CosmeticsState, String> {
    let path = confined_read(csgo, SERVER_CFG)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CosmeticsState { cosmetics: Cosmetics::default(), cfg_present: false })
        }
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    Ok(CosmeticsState { cosmetics: cosmetics_in(&text), cfg_present: true })
}

/// The three values in a cfg's text; a missing or unreadable line is the plugin's default.
fn cosmetics_in(text: &str) -> Cosmetics {
    let b = |name: &str| cfg::read(text, name).and_then(|v| parse_bool(&v)).unwrap_or(false);
    Cosmetics {
        dropped_knife_skins: b(COSMETIC_CONVARS[0]),
        dropped_knife_premium: b(COSMETIC_CONVARS[1]),
        music_kit: cfg::read(text, COSMETIC_CONVARS[2]).and_then(|v| v.parse().ok()).unwrap_or(0),
    }
}

/// A kit id must be 0, -1 or listed in the installed BotRandomizer's `musicKits`. The plugin
/// ignores an unknown id with only a log line, which the player would never see.
fn check_music_kit(csgo: &Path, id: i32) -> Result<(), String> {
    if id == 0 || id == -1 {
        return Ok(());
    }
    let path = confined_read(csgo, CATALOG)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("{}: {e}; cannot check music kit {id}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let kits = v.get("musicKits").and_then(|k| k.as_array()).ok_or_else(|| format!("{}: no musicKits list", path.display()))?;
    if kits.iter().any(|k| k.as_i64() == Some(i64::from(id))) {
        Ok(())
    } else {
        Err(format!("music kit {id} is not in BotRandomizer's catalog"))
    }
}

/// Writes all three convars, zeros included: a CounterStrikeSharp FakeConVar keeps its
/// value across map changes, so a deleted line would leave the old value active.
pub fn set_cosmetics(layout: &Layout, probe: &dyn ProcessProbe, c: Cosmetics) -> Result<Meta, String> {
    set_cosmetics_from(layout, probe, c, None)
}

/// [`set_cosmetics`] for a caller that read the values first and changed some of them (the
/// app's Bot Mode view, `botmode set`): refused, writing nothing, when the cfg no longer holds
/// `seen`, so a value changed in between is never overwritten with the stale one. The write
/// itself is a compare-and-swap against the cfg as read here
/// (`ChangeSet::put_merged_cfg_if_unchanged`).
pub fn set_cosmetics_from(layout: &Layout, probe: &dyn ProcessProbe, c: Cosmetics, seen: Option<Cosmetics>) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let path = layout.confined(SERVER_CFG)?;
    let (text, read_hash) = match std::fs::read(&path) {
        Ok(b) => {
            let h = hash::bytes(&b);
            (String::from_utf8(b).map_err(|e| format!("{}: {e}", path.display()))?, Some(h))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (NEW_CFG_HEADER.to_string(), None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let now = if read_hash.is_some() { cosmetics_in(&text) } else { Cosmetics::default() };
    // only a kit this change sets is checked, as in set_server
    if c.music_kit != now.music_kit {
        check_music_kit(&layout.csgo, c.music_kit)?;
    }
    if let Some(seen) = seen {
        if now != seen {
            return Err(format!(
                "{SERVER_CFG}: the Bot Mode cosmetics {} (now br_dropped_knife_skins {}, br_dropped_knife_premium {}, br_player_music_kit {}); nothing was written",
                changes::CHANGED_SINCE_READ,
                u8::from(now.dropped_knife_skins),
                u8::from(now.dropped_knife_premium),
                now.music_kit
            ));
        }
    }
    let flag = |b: bool| if b { "1" } else { "0" }.to_string();
    let merged = cfg::merge(
        &text,
        &[
            (COSMETIC_CONVARS[0], flag(c.dropped_knife_skins)),
            (COSMETIC_CONVARS[1], flag(c.dropped_knife_premium)),
            (COSMETIC_CONVARS[2], c.music_kit.to_string()),
        ],
    );
    let (_, meta) = changes::run(layout, probe, &lock, "cosmetics", |cs| {
        cs.put_merged_cfg_if_unchanged(SERVER_CFG, merged.as_bytes(), read_hash.as_deref())
    })?;
    Ok(meta)
}

/// What the installed BotRandomizer's catalog offers the Bot Mode view: the music kits
/// `br_player_music_kit` accepts, the knives a dropped-knife finish can land on, and the
/// finish weights `br_dropped_knife_premium` squares.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub music_kits: Vec<MusicKit>,
    /// Item definition indexes, in the catalog's order.
    pub knives: Vec<u32>,
    pub knife_finishes: Vec<KnifeFinish>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MusicKit {
    pub id: i32,
    /// From `musicKitNames`, which only the user's BotRandomizer build ships.
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KnifeFinish {
    pub finish: String,
    pub weight: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogFile {
    #[serde(default)]
    music_kits: Vec<i32>,
    #[serde(default)]
    music_kit_names: BTreeMap<String, String>,
    #[serde(default)]
    knives: Vec<CatalogKnife>,
    #[serde(default)]
    knife_finish_preferences: Vec<KnifeFinish>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogKnife {
    def_index: u32,
}

/// Reads the installed BotRandomizer's `cosmetic_catalog.json`; `None` when there is none.
pub fn read_catalog(csgo: &Path) -> Result<Option<Catalog>, String> {
    let path = confined_read(csgo, CATALOG)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let f: CatalogFile = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Some(Catalog {
        music_kits: f.music_kits.iter().map(|&id| MusicKit { id, name: f.music_kit_names.get(&id.to_string()).cloned() }).collect(),
        knives: f.knives.iter().map(|k| k.def_index).collect(),
        knife_finishes: f.knife_finish_preferences,
    }))
}

/// `bot_aim`, BotAimImprover's aim preset. Without a line the plugin uses mixed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BotAim {
    Head,
    Body,
    Mixed,
}

/// `bot_nades`, NadeSystem's grenade preset. Without a line the plugin uses normal.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BotNades {
    Off,
    Less,
    Normal,
    More,
    Max,
}

impl BotAim {
    const ALL: [(BotAim, &'static str); 3] = [(BotAim::Head, "head"), (BotAim::Body, "body"), (BotAim::Mixed, "mixed")];
    fn name(self) -> &'static str {
        Self::ALL.iter().find(|(a, _)| *a == self).map(|(_, n)| *n).unwrap_or("mixed")
    }
    fn parse(s: &str) -> Option<BotAim> {
        Self::ALL.iter().find(|(_, n)| n.eq_ignore_ascii_case(s)).map(|(a, _)| *a)
    }
}

impl BotNades {
    const ALL: [(BotNades, &'static str); 5] =
        [(BotNades::Off, "off"), (BotNades::Less, "less"), (BotNades::Normal, "normal"), (BotNades::More, "more"), (BotNades::Max, "max")];
    fn name(self) -> &'static str {
        Self::ALL.iter().find(|(a, _)| *a == self).map(|(_, n)| *n).unwrap_or("normal")
    }
    fn parse(s: &str) -> Option<BotNades> {
        Self::ALL.iter().find(|(_, n)| n.eq_ignore_ascii_case(s)).map(|(a, _)| *a)
    }
}

/// The knives `subclass_create` can spawn, by item definition index: the mod's own knife bind
/// in `my_bot_normal_config.cfg` lists exactly these.
pub const KNIVES: [u32; 20] = [500, 503, 505, 506, 507, 508, 509, 512, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 525, 526];

/// This app's knife-drop bind: a key that spawns the chosen knives with `subclass_create`. It
/// is one line in the server cfg, marked with [`KNIFE_MARK`]; the cfg runs after the mod's cfgs,
/// so the bind wins over the mod's own one on the same key. When the key changes, the line
/// before it unbinds the previous key, since CS2 keeps a key's bind in the user's key settings.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnifeBind {
    pub key: String,
    pub knives: Vec<u32>,
}

/// Ends every line of the server cfg this app manages for the knife bind.
pub const KNIFE_MARK: &str = "// cs2-stats knife drop";

/// A key name the console accepts unquoted: one character, or a name such as `mouse4` or `kp_end`.
fn check_key(key: &str) -> Result<(), String> {
    let one = key.chars().count() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric() || "\\`[]-=,./'".contains(c));
    let name = (2..=16).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if one || name {
        Ok(())
    } else {
        Err(format!("{key:?}: not a key name; use one character or a name such as mouse4 or kp_end"))
    }
}

impl KnifeBind {
    fn check(&self) -> Result<(), String> {
        check_key(&self.key)?;
        if self.knives.is_empty() {
            return Err("choose at least one knife for the knife-drop bind".into());
        }
        for (i, k) in self.knives.iter().enumerate() {
            if !KNIVES.contains(k) {
                return Err(format!("knife {k} is not one subclass_create spawns"));
            }
            if self.knives[..i].contains(k) {
                return Err(format!("knife {k} is listed twice"));
            }
        }
        Ok(())
    }

    fn line(&self) -> String {
        let cmds: Vec<String> = self.knives.iter().map(|k| format!("subclass_create {k}")).collect();
        format!("bind {} \"{}\" {KNIFE_MARK}", self.key, cmds.join(";"))
    }

    /// The bind on a line this app wrote: exactly [`line`](Self::line)'s form, with a key and
    /// knives that pass [`check`](Self::check). Anything else, even with the marker, is the
    /// user's and is neither read nor touched.
    fn parse(line: &str) -> Option<KnifeBind> {
        let code = line.trim_end().strip_suffix(KNIFE_MARK)?.strip_suffix(' ')?;
        let rest = code.strip_prefix("bind ")?;
        let (key, cmds) = rest.split_once(' ')?;
        let cmds = cmds.strip_prefix('"')?.strip_suffix('"')?;
        let knives = cmds.split(';').map(|c| c.strip_prefix("subclass_create ")?.parse().ok()).collect::<Option<Vec<u32>>>()?;
        let bind = KnifeBind { key: key.to_string(), knives };
        (bind.check().is_ok() && bind.line() == line.trim_end()).then_some(bind)
    }
}

/// An `unbind` line this app wrote when the knife key moved, in exactly that form.
fn managed_unbind(line: &str) -> bool {
    let Some(key) = line.trim_end().strip_suffix(KNIFE_MARK).and_then(|c| c.strip_suffix(' ')).and_then(|c| c.strip_prefix("unbind ")) else { return false };
    check_key(key).is_ok()
}

/// A line of this app's knife bind: replaced on every change to it.
fn managed(line: &str) -> bool {
    KnifeBind::parse(line).is_some() || managed_unbind(line)
}

/// Everything this app sets in `cfg\gamemode_competitive_server.cfg`, as the game will read it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub cosmetics: Cosmetics,
    /// `None` when no line sets it, so the plugin's default applies.
    pub bot_aim: Option<BotAim>,
    pub bot_nades: Option<BotNades>,
    /// `None` when the cfg has no knife bind of this app's; the mod's own bind applies.
    pub knife_bind: Option<KnifeBind>,
}

/// The changes to make; a field left out keeps what the cfg has.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerPatch {
    #[serde(default)]
    pub cosmetics: Option<Cosmetics>,
    #[serde(default)]
    pub bot_aim: Option<BotAim>,
    #[serde(default)]
    pub bot_nades: Option<BotNades>,
    #[serde(default)]
    pub knife_bind: Option<KnifeBind>,
}

fn server_in(text: &str) -> ServerSettings {
    ServerSettings {
        cosmetics: cosmetics_in(text),
        bot_aim: cfg::read(text, "bot_aim").and_then(|v| BotAim::parse(&v)),
        bot_nades: cfg::read(text, "bot_nades").and_then(|v| BotNades::parse(&v)),
        knife_bind: text.lines().filter_map(KnifeBind::parse).last(),
    }
}

pub fn read_server(csgo: &Path) -> Result<ServerSettings, String> {
    let path = confined_read(csgo, SERVER_CFG)?;
    match std::fs::read_to_string(&path) {
        Ok(t) => Ok(server_in(&t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ServerSettings::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The cfg's text with `patch` applied: convar lines merged (every other line kept), and this
/// app's knife-bind lines replaced.
fn apply_patch(text: &str, now: &ServerSettings, patch: &ServerPatch) -> String {
    let flag = |b: bool| if b { "1" } else { "0" }.to_string();
    let mut values: Vec<(&str, String)> = Vec::new();
    if let Some(c) = patch.cosmetics {
        values.push((COSMETIC_CONVARS[0], flag(c.dropped_knife_skins)));
        values.push((COSMETIC_CONVARS[1], flag(c.dropped_knife_premium)));
        values.push((COSMETIC_CONVARS[2], c.music_kit.to_string()));
    }
    if let Some(a) = patch.bot_aim {
        values.push(("bot_aim", a.name().into()));
    }
    if let Some(n) = patch.bot_nades {
        values.push(("bot_nades", n.name().into()));
    }
    let mut out = if values.is_empty() { text.to_string() } else { cfg::merge(text, &values) };
    if let Some(bind) = &patch.knife_bind {
        let eol = if out.contains("\r\n") { "\r\n" } else { "\n" };
        let mut lines: Vec<&str> = out.lines().filter(|l| !managed(l)).collect();
        let unbind = now.knife_bind.as_ref().filter(|old| !old.key.eq_ignore_ascii_case(&bind.key)).map(|old| format!("unbind {} {KNIFE_MARK}", old.key));
        let line = bind.line();
        if let Some(u) = &unbind {
            lines.push(u);
        }
        lines.push(&line);
        let mut joined = lines.join(eol);
        joined.push_str(eol);
        out = joined;
    }
    out
}

/// Applies `patch` to the server cfg as one change, refused (writing nothing) when the cfg no
/// longer holds `seen`, what the caller read. The write is a compare-and-swap against the cfg
/// as read here, as in [`set_cosmetics_from`].
pub fn set_server(layout: &Layout, probe: &dyn ProcessProbe, patch: ServerPatch, seen: ServerSettings) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    if let Some(b) = &patch.knife_bind {
        b.check()?;
    }
    let path = layout.confined(SERVER_CFG)?;
    let (text, read_hash) = match std::fs::read(&path) {
        Ok(b) => {
            let h = hash::bytes(&b);
            (String::from_utf8(b).map_err(|e| format!("{}: {e}", path.display()))?, Some(h))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (NEW_CFG_HEADER.to_string(), None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let now = if read_hash.is_some() { server_in(&text) } else { ServerSettings::default() };
    if now != seen {
        return Err(format!("{SERVER_CFG}: the Bot Mode settings {}; nothing was written", changes::CHANGED_SINCE_READ));
    }
    // only a kit this change sets is checked: one already in the cfg (from an older catalog, or
    // with no catalog to check against) must not block a change to another setting
    if let Some(c) = patch.cosmetics.filter(|c| c.music_kit != now.cosmetics.music_kit) {
        check_music_kit(&layout.csgo, c.music_kit)?;
    }
    let merged = apply_patch(&text, &now, &patch);
    let (_, meta) = changes::run(layout, probe, &lock, "server-cfg", |cs| {
        cs.put_merged_cfg_if_unchanged(SERVER_CFG, merged.as_bytes(), read_hash.as_deref())
    })?;
    Ok(meta)
}

/// Settings that live in the app, not the game folder.
#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Added after `-insecure` when Bot Mode starts CS2, on top of the launch options set in
    /// Steam, which Steam adds itself.
    #[serde(default)]
    pub launch_options: String,
}

pub fn load_app(layout: &Layout) -> Result<AppSettings, String> {
    let path = layout.settings_file();
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AppSettings::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn save_app(layout: &Layout, s: &AppSettings) -> Result<(), String> {
    super::launch::steam_args(&s.launch_options)?;
    let _lock = OpLock::acquire(layout)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&layout.settings_file(), text.as_bytes())
}
