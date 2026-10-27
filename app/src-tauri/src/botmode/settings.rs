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
use super::state;
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
    Ok(active_profile(csgo)?.0)
}

/// The active level and the active profile's SHA-256, from one read of the profile, so the
/// level the view shows and the hash a difficulty change sends back describe the same file.
pub fn active_profile(csgo: &Path) -> Result<(Option<Difficulty>, Option<String>), String> {
    let active = hash::file_if_exists(&confined_read(csgo, ACTIVE_PROFILE)?)?;
    Ok((difficulty_of(csgo, active.as_deref())?, active))
}

fn difficulty_of(csgo: &Path, active: Option<&str>) -> Result<Option<Difficulty>, String> {
    let Some(active) = active else { return Ok(None) };
    for d in Difficulty::ALL {
        if hash::file_if_exists(&confined_read(csgo, d.variant())?)?.as_deref() == Some(active) {
            return Ok(Some(d));
        }
    }
    Ok(None)
}

pub fn set_difficulty(layout: &Layout, probe: &dyn ProcessProbe, level: Difficulty) -> Result<Meta, String> {
    set_difficulty_from(layout, probe, level, None)
}

/// What a caller saw of a file before asking to change it: its SHA-256, or `None` when it was absent.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSeen {
    pub sha256: Option<String>,
}

/// [`set_difficulty`] for a caller that showed the user the active profile first (the view's
/// preview, or a change kept while CS2 ran): refused, writing nothing, when
/// `overrides/botprofile.vpk` no longer has the content `seen` describes. The copy itself is a
/// compare-and-swap against the profile as read here.
pub fn set_difficulty_from(layout: &Layout, probe: &dyn ProcessProbe, level: Difficulty, seen: Option<&FileSeen>) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let src = layout.confined(level.variant())?;
    let sha = hash::file_if_exists(&src)?
        .ok_or_else(|| format!("{} is missing; install the mod first", level.variant()))?;
    let now = hash::file_if_exists(&confined_read(&layout.csgo, ACTIVE_PROFILE)?)?;
    if let Some(seen) = seen {
        if seen.sha256 != now {
            return Err(format!("{ACTIVE_PROFILE}: {}; nothing was written", changes::CHANGED_SINCE_READ));
        }
    }
    let (_, meta) = changes::run(layout, probe, &lock, &format!("difficulty-{}", level.name()), |cs| {
        cs.put_file_if_unchanged(ACTIVE_PROFILE, &src, &sha, now.as_deref())
    })?;
    Ok(meta)
}

/// The SHA-256 of the active bot profile, for a caller to send back as [`FileSeen`].
pub fn active_profile_sha(csgo: &Path) -> Result<Option<String>, String> {
    hash::file_if_exists(&confined_read(csgo, ACTIVE_PROFILE)?)
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
/// so the bind wins over the mod's own one on the same key.
///
/// A key the bind moves away from would keep spawning knives: CS2 keeps a key's bind in the
/// user's key settings, and the mod's own cfg binds [`MOD_KNIFE_KEY`] again on every map. So
/// every key the bind has left, the mod's included, joins a set of keys Bot Mode keeps unbound:
/// one marked `unbind <key>` line each, which the cfg runs on every map, for good. Nothing takes
/// a key out of the set except the user (`ServerPatch::stop_unbinding`); the current key is the
/// one exception, as the bind line after the `unbind` lines claims it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnifeBind {
    pub key: String,
    pub knives: Vec<u32>,
}

/// Ends every line of the server cfg this app manages for the knife bind.
pub const KNIFE_MARK: &str = "// cs2-stats knife drop";

/// The key the mod's own cfgs bind to spawn every knife (`my_bot_*_config.cfg`).
pub const MOD_KNIFE_KEY: &str = "\\";

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

/// The key of an `unbind` line this app wrote: exactly the form it writes, for a key in `ours`,
/// the record of the unbind lines it wrote (`State::knife_unbinds`). The marker alone proves
/// nothing, as anyone can type it; a marked line for another key is the user's.
fn managed_unbind<'a>(line: &'a str, ours: &[String]) -> Option<&'a str> {
    let key = line.trim_end().strip_suffix(KNIFE_MARK)?.strip_suffix(' ')?.strip_prefix("unbind ")?;
    (check_key(key).is_ok() && ours.iter().any(|o| o == key)).then_some(key)
}

/// A line of this app's knife bind: replaced on every change to it.
fn managed(line: &str, ours: &[String]) -> bool {
    KnifeBind::parse(line).is_some() || managed_unbind(line, ours).is_some()
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
    /// The keys Bot Mode keeps unbound (see [`KnifeBind`]), in the order they joined.
    #[serde(default)]
    pub unbound_keys: Vec<String>,
}

/// The changes to make; a field left out keeps what the cfg has.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cosmetics: Option<Cosmetics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_aim: Option<BotAim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_nades: Option<BotNades>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knife_bind: Option<KnifeBind>,
    /// Keys the user takes out of the set Bot Mode keeps unbound.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_unbinding: Vec<String>,
}

fn server_in(text: &str, ours: &[String]) -> ServerSettings {
    ServerSettings {
        cosmetics: cosmetics_in(text),
        bot_aim: cfg::read(text, "bot_aim").and_then(|v| BotAim::parse(&v)),
        bot_nades: cfg::read(text, "bot_nades").and_then(|v| BotNades::parse(&v)),
        knife_bind: text.lines().filter_map(KnifeBind::parse).last(),
        unbound_keys: unbound_keys(text, ours),
    }
}

pub fn read_server(layout: &Layout) -> Result<ServerSettings, String> {
    let ours = state::load(layout)?.knife_unbinds;
    let path = confined_read(&layout.csgo, SERVER_CFG)?;
    match std::fs::read_to_string(&path) {
        Ok(t) => Ok(server_in(&t, &ours)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ServerSettings::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// The keys this app's `unbind` lines in `text` name, in order, each once.
fn unbound_keys(text: &str, ours: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in text.lines().filter_map(|l| managed_unbind(l, ours)) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(k)) {
            out.push(k.to_string());
        }
    }
    out
}

/// The cfg's text with `patch` applied: convar lines merged (every other line kept), and this
/// app's knife-bind lines rewritten: an `unbind` line for every key in the set but the bound one,
/// then the bind. Also returns the keys of the `unbind` lines it leaves, the new record; `None`
/// when the knife lines were not touched.
fn apply_patch(text: &str, now: &ServerSettings, patch: &ServerPatch, ours: &[String]) -> (String, Option<Vec<String>>) {
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
    let mut record = None;
    if patch.knife_bind.is_some() || !patch.stop_unbinding.is_empty() {
        let mut keys = now.unbound_keys.clone();
        let add = |keys: &mut Vec<String>, k: &str| {
            if !keys.iter().any(|o| o.eq_ignore_ascii_case(k)) {
                keys.push(k.to_string());
            }
        };
        if let Some(bind) = &patch.knife_bind {
            // the key the knives spawned on until now: this app's, or else the mod's own
            let old = now.knife_bind.as_ref().map_or(MOD_KNIFE_KEY, |b| b.key.as_str());
            if !old.eq_ignore_ascii_case(&bind.key) {
                add(&mut keys, old);
            }
        }
        keys.retain(|k| !patch.stop_unbinding.iter().any(|s| s.eq_ignore_ascii_case(k)));
        let bind = patch.knife_bind.as_ref().or(now.knife_bind.as_ref());
        let eol = if out.contains("\r\n") { "\r\n" } else { "\n" };
        let mut lines: Vec<String> = out.lines().filter(|l| !managed(l, ours)).map(str::to_string).collect();
        // the bound key gets no unbind line, as its bind claims it; it rejoins when the bind moves off it
        let current = bind.map(|b| b.key.as_str());
        let emitted: Vec<String> = keys.into_iter().filter(|k| current.map_or(true, |c| !c.eq_ignore_ascii_case(k))).collect();
        lines.extend(emitted.iter().map(|k| format!("unbind {k} {KNIFE_MARK}")));
        lines.extend(bind.map(KnifeBind::line));
        let mut joined = lines.join(eol);
        joined.push_str(eol);
        out = joined;
        record = Some(emitted);
    }
    (out, record)
}

/// The bind the knives spawn on: this app's, or the mod's own, which spawns every knife.
fn effective_bind(b: &Option<KnifeBind>) -> KnifeBind {
    b.clone().unwrap_or_else(|| KnifeBind { key: MOD_KNIFE_KEY.into(), knives: KNIVES.to_vec() })
}

/// Undoing a change to the server cfg, as a change forward rather than a restore of the old
/// bytes: CS2 has already saved the binds the change made, so putting the old file back would
/// leave the newer knife key bound. The patch sets each setting back to what the cfg held before
/// change `id`, through the same rules as any edit: the knife key moves back, the key it leaves
/// joins the keys Bot Mode keeps unbound, and nothing leaves that set. Settings the change did not
/// touch, or that are already back, are left out. Reads only.
pub fn undo_patch(layout: &Layout, id: &str) -> Result<ServerPatch, String> {
    let before = match changes::before_bytes(layout, id, SERVER_CFG)? {
        Some(b) => String::from_utf8(b).map_err(|e| format!("{SERVER_CFG} before change {id}: {e}"))?,
        None => String::new(),
    };
    let was = server_in(&before, &[]);
    let now = read_server(layout)?;
    let mut patch = ServerPatch::default();
    if was.cosmetics != now.cosmetics {
        patch.cosmetics = Some(was.cosmetics);
    }
    // no line means the plugin's default, so that is what "back" sets
    let aim = |a: Option<BotAim>| a.unwrap_or(BotAim::Mixed);
    if aim(was.bot_aim) != aim(now.bot_aim) {
        patch.bot_aim = Some(aim(was.bot_aim));
    }
    let nades = |n: Option<BotNades>| n.unwrap_or(BotNades::Normal);
    if nades(was.bot_nades) != nades(now.bot_nades) {
        patch.bot_nades = Some(nades(was.bot_nades));
    }
    if effective_bind(&was.knife_bind) != effective_bind(&now.knife_bind) {
        patch.knife_bind = Some(effective_bind(&was.knife_bind));
    }
    Ok(patch)
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
    let mut st = state::load(layout)?;
    let now = if read_hash.is_some() { server_in(&text, &st.knife_unbinds) } else { ServerSettings::default() };
    if now != seen {
        return Err(format!("{SERVER_CFG}: the Bot Mode settings {}; nothing was written", changes::CHANGED_SINCE_READ));
    }
    // only a kit this change sets is checked: one already in the cfg (from an older catalog, or
    // with no catalog to check against) must not block a change to another setting
    if let Some(c) = patch.cosmetics.filter(|c| c.music_kit != now.cosmetics.music_kit) {
        check_music_kit(&layout.csgo, c.music_kit)?;
    }
    if let Some(k) = patch.stop_unbinding.iter().find(|k| check_key(k).is_err()) {
        return Err(format!("{k:?}: not a key name"));
    }
    let (merged, record) = apply_patch(&text, &now, &patch, &st.knife_unbinds);
    let (_, meta) = changes::run(layout, probe, &lock, "server-cfg", |cs| {
        cs.put_merged_cfg_if_unchanged(SERVER_CFG, merged.as_bytes(), read_hash.as_deref())?;
        // the record of the unbind lines this app wrote goes with the cfg: a rollback restores both
        if let Some(record) = record.filter(|r| *r != st.knife_unbinds) {
            st.knife_unbinds = record;
            state::save(layout, &st)?;
        }
        Ok(())
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

/// Sets the app's launch options, refused when they are no longer `seen`, what the caller showed
/// the user (the view's preview, or a change kept while CS2 ran). The read, the check and the
/// write happen under the operation lock.
pub fn set_launch_options(layout: &Layout, options: &str, seen: Option<&str>) -> Result<AppSettings, String> {
    super::launch::steam_args(options)?;
    let _lock = OpLock::acquire(layout)?;
    let mut s = load_app(layout)?;
    if seen.is_some_and(|seen| seen != s.launch_options) {
        return Err(format!("the app's launch options {} (now {:?}); nothing was written", changes::CHANGED_SINCE_READ, s.launch_options));
    }
    s.launch_options = options.to_string();
    let text = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    write_atomic(&layout.settings_file(), text.as_bytes())?;
    Ok(s)
}

pub fn save_app(layout: &Layout, s: &AppSettings) -> Result<(), String> {
    super::launch::steam_args(&s.launch_options)?;
    let _lock = OpLock::acquire(layout)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&layout.settings_file(), text.as_bytes())
}
