//! Bot difficulty, the player's BotRandomizer cosmetics, and the app's own launch options.
//!
//! Difficulty is the mod's documented mechanism (README, "How to manually change the
//! difficulty level?"): copy `overrides\<Low|Medium|High>\botprofile.vpk` over
//! `overrides\botprofile.vpk`. The cosmetics are three BotRandomizer convars, merged into
//! `cfg\gamemode_competitive_server.cfg`, which runs after the mod's cfgs and which game and
//! mod updates do not ship. The same cfg takes the mod's `bot_aim` and `bot_nades` presets
//! (its BotAimImprover and NadeSystem READMEs list the values) and one line that runs this app's
//! knife file, [`KNIFE_CFG`], which holds the knife-drop bind (see [`Knife`]). Each settings change
//! keeps a record of what it changed, so Undo goes forward from it ([`undo_server`]).

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
    let r = read_all(layout)?;
    let now = r.now.cosmetics;
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
    let patch = ServerPatch { cosmetics: Some(c), ..Default::default() };
    write_settings(layout, probe, &lock, "cosmetics", &r, &values_of(&patch), None)
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
/// lives in the knife file, [`KNIFE_CFG`], with the keys Bot Mode keeps unbound (see [`Knife`]).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnifeBind {
    pub key: String,
    pub knives: Vec<u32>,
}

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

    /// The mod's own bind: `\`, every knife.
    fn of_mod() -> KnifeBind {
        KnifeBind { key: MOD_KNIFE_KEY.into(), knives: KNIVES.to_vec() }
    }

    fn line(&self) -> String {
        let cmds: Vec<String> = self.knives.iter().map(|k| format!("subclass_create {k}")).collect();
        format!("bind {} \"{}\"", self.key, cmds.join(";"))
    }
}

/// The file that holds this app's knife key, in the game's `cfg` folder. The app writes it whole:
/// a header, an `unbind` line for each key Bot Mode keeps unbound, then the bind. The server cfg
/// runs it with one line, [`KNIFE_EXEC_LINE`], which the app adds once, where its knife lines used
/// to go (the end), and never removes. Nothing in the server cfg is read as the app's: the file is
/// the only record of the knife key, and a hand edit to it is the user's choice.
pub const KNIFE_CFG: &str = "cfg/cs2stats_knife.cfg";
const KNIFE_EXEC: &str = "cs2stats_knife";
pub const KNIFE_EXEC_LINE: &str = "exec cs2stats_knife // cs2-stats knife drop";
const KNIFE_HEADER: [&str; 3] = [
    "// Bot Mode's knife key, managed by CS2 Stats. The server cfg runs this file on every map",
    "// (exec cs2stats_knife). CS2 Stats rewrites it whole when you change the knife key, keeping",
    "// any line of yours it does not write.",
];

/// What the knife file holds. A key the bind leaves would keep spawning knives: CS2 keeps a key's
/// bind in the user's key settings, and the mod's own cfg binds [`MOD_KNIFE_KEY`] again on every
/// map. So every key the bind leaves, the mod's included, joins `unbound`, and stays until the user
/// takes it out (`ServerPatch::stop_unbinding`) or the bind moves back onto it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Knife {
    /// `None`: no bind line, so the mod's own bind applies.
    pub bind: Option<KnifeBind>,
    /// Keys Bot Mode keeps unbound, in the file's order.
    pub unbound: Vec<String>,
}

impl Knife {
    /// The key the knives spawn on: the bind's, or the mod's own.
    fn key(&self) -> &str {
        self.bind.as_ref().map_or(MOD_KNIFE_KEY, |b| b.key.as_str())
    }

    fn add(&mut self, key: &str) {
        if !self.unbound.iter().any(|k| k.eq_ignore_ascii_case(key)) {
            self.unbound.push(key.to_string());
        }
    }

    /// The knife key after `patch`: the key the bind leaves joins the set, keys the user takes
    /// out leave it, and the bound key is never in it (its bind claims it).
    fn after(&self, patch: &ServerPatch) -> Knife {
        let mut next = self.clone();
        if let Some(bind) = &patch.knife_bind {
            if !self.key().eq_ignore_ascii_case(&bind.key) {
                next.add(self.key());
            }
            next.bind = Some(bind.clone());
        }
        next.unbound.retain(|k| !patch.stop_unbinding.iter().any(|s| s.eq_ignore_ascii_case(k)));
        let key = next.key().to_string();
        next.unbound.retain(|k| !k.eq_ignore_ascii_case(&key));
        next
    }

    /// The knife key that undoes the change from `before` to `after`: the old key bound again,
    /// the key being left unbound, and the keys the change took out of the set back in it:
    /// bind = B.k, set = (B.s ∪ {A.k}) \ {B.k}.
    fn undo(before: &Knife, after: &Knife) -> Knife {
        let mut next = Knife { bind: Some(before.bind.clone().unwrap_or_else(KnifeBind::of_mod)), unbound: before.unbound.clone() };
        next.add(after.key());
        let key = before.key().to_string();
        next.unbound.retain(|k| !k.eq_ignore_ascii_case(&key));
        next
    }

    /// The whole file: the header, the user's own lines as they were, then the app's.
    fn text(&self, other: &[String]) -> String {
        let mut lines: Vec<String> = KNIFE_HEADER.iter().map(|l| l.to_string()).collect();
        lines.extend(other.iter().cloned());
        lines.extend(self.unbound.iter().map(|k| format!("unbind {k}")));
        lines.extend(self.bind.iter().map(KnifeBind::line));
        let mut out = lines.join("\r\n");
        out.push_str("\r\n");
        out
    }

    /// The knife key in a knife file's text, and its other lines (not the header's), which a
    /// rewrite keeps. A bind line counts only in exactly the form [`KnifeBind::line`] writes,
    /// with a key and knives that pass [`KnifeBind::check`]; the last one wins, as in the game.
    fn read(text: &str) -> (Knife, Vec<String>) {
        let mut knife = Knife::default();
        let mut other = Vec::new();
        for line in text.lines() {
            if KNIFE_HEADER.contains(&line) || line.trim().is_empty() {
                continue;
            }
            let words = cfg::line_words(line);
            match words.as_deref() {
                Some(["unbind", key]) if check_key(key).is_ok() => knife.add(key),
                Some(["bind", key, cmds]) => {
                    let knives = cmds.split(';').map(|c| c.strip_prefix("subclass_create ")?.parse().ok()).collect::<Option<Vec<u32>>>();
                    match knives.map(|knives| KnifeBind { key: key.to_string(), knives }).filter(|b| b.check().is_ok() && b.line() == line.trim()) {
                        Some(b) => knife.bind = Some(b),
                        None => other.push(line.to_string()),
                    }
                }
                _ => other.push(line.to_string()),
            }
        }
        // the bound key's bind wins over an unbind line before it
        let key = knife.key().to_string();
        if knife.bind.is_some() {
            knife.unbound.retain(|k| !k.eq_ignore_ascii_case(&key));
        }
        (knife, other)
    }
}

/// How the knife file stands.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum KnifeFileStatus {
    /// No file and no exec line: the mod's own knife key applies.
    #[default]
    None,
    /// The server cfg runs the file, and it was read.
    Ok,
    /// The server cfg runs the file, but it is gone: which keys stay unbound is unknown.
    Missing,
    /// The file is there but could not be read.
    Unreadable,
    /// The file is there, but the server cfg no longer runs it.
    NotRun,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnifeFile {
    /// The game path, [`KNIFE_CFG`].
    pub path: String,
    pub status: KnifeFileStatus,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

impl Default for KnifeFile {
    fn default() -> KnifeFile {
        KnifeFile { path: KNIFE_CFG.into(), status: KnifeFileStatus::None, sha256: None, error: None }
    }
}

/// Everything this app sets for the game: the server cfg's convars and the knife file.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub cosmetics: Cosmetics,
    /// `None` when no line sets it, so the plugin's default applies.
    pub bot_aim: Option<BotAim>,
    pub bot_nades: Option<BotNades>,
    /// The knife file's bind; `None` when it has none (or there is no file): the mod's own applies.
    pub knife_bind: Option<KnifeBind>,
    /// The keys the knife file unbinds, in its order.
    #[serde(default)]
    pub unbound_keys: Vec<String>,
    #[serde(default)]
    pub knife_file: KnifeFile,
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

/// The server cfg and the knife file as read, with the hashes their writes compare against.
struct Read {
    /// The server cfg's text; a new file's header when there is none.
    text: String,
    hash: Option<String>,
    knife_text: Option<String>,
    knife_hash: Option<String>,
    knife: Knife,
    /// The knife file's lines the app does not write.
    other: Vec<String>,
    now: ServerSettings,
}

fn read_all(layout: &Layout) -> Result<Read, String> {
    let path = confined_read(&layout.csgo, SERVER_CFG)?;
    let (text, hash) = match std::fs::read(&path) {
        Ok(b) => {
            let h = hash::bytes(&b);
            (String::from_utf8(b).map_err(|e| format!("{}: {e}", path.display()))?, Some(h))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (NEW_CFG_HEADER.to_string(), None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let exec = hash.is_some() && cfg::execs(&text, KNIFE_EXEC);
    let kpath = confined_read(&layout.csgo, KNIFE_CFG)?;
    let mut file = KnifeFile::default();
    let (mut knife_text, mut knife_hash) = (None, None);
    match std::fs::read(&kpath) {
        Ok(b) => {
            let h = hash::bytes(&b);
            match String::from_utf8(b) {
                Ok(t) => {
                    file.status = if exec { KnifeFileStatus::Ok } else { KnifeFileStatus::NotRun };
                    knife_text = Some(t);
                }
                Err(e) => {
                    file.status = KnifeFileStatus::Unreadable;
                    file.error = Some(format!("{KNIFE_CFG}: {e}"));
                }
            }
            file.sha256 = Some(h.clone());
            knife_hash = Some(h);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            file.status = if exec { KnifeFileStatus::Missing } else { KnifeFileStatus::None };
        }
        Err(e) => {
            file.status = KnifeFileStatus::Unreadable;
            file.error = Some(format!("{KNIFE_CFG}: {e}"));
        }
    }
    let (knife, other) = knife_text.as_deref().map(Knife::read).unwrap_or_default();
    let now = ServerSettings {
        cosmetics: if hash.is_some() { cosmetics_in(&text) } else { Cosmetics::default() },
        bot_aim: cfg::read(&text, "bot_aim").and_then(|v| BotAim::parse(&v)),
        bot_nades: cfg::read(&text, "bot_nades").and_then(|v| BotNades::parse(&v)),
        knife_bind: knife.bind.clone(),
        unbound_keys: knife.unbound.clone(),
        knife_file: file,
    };
    Ok(Read { text, hash, knife_text, knife_hash, knife, other, now })
}

pub fn read_server(layout: &Layout) -> Result<ServerSettings, String> {
    Ok(read_all(layout)?.now)
}

/// The scalar settings a change can touch, each with the value the game uses without a line.
const SCALARS: [(&str, &str); 5] =
    [(COSMETIC_CONVARS[0], "0"), (COSMETIC_CONVARS[1], "0"), (COSMETIC_CONVARS[2], "0"), ("bot_aim", "mixed"), ("bot_nades", "normal")];

fn scalar_default(name: &str) -> &'static str {
    SCALARS.iter().find(|(n, _)| *n == name).map_or("", |(_, d)| d)
}

/// The value a scalar has in the cfg's text, written the way this app writes it; `None` when no
/// line sets it, or none the plugin would accept.
fn scalar_in(text: &str, name: &str) -> Option<String> {
    let raw = cfg::read(text, name)?;
    match name {
        "bot_aim" => BotAim::parse(&raw).map(|a| a.name().to_string()),
        "bot_nades" => BotNades::parse(&raw).map(|n| n.name().to_string()),
        n if n == COSMETIC_CONVARS[2] => raw.parse::<i32>().ok().map(|v| v.to_string()),
        _ => parse_bool(&raw).map(|b| if b { "1" } else { "0" }.to_string()),
    }
}

/// What one change did to the settings, kept in its backup folder so Undo can check that the
/// settings still hold what it wrote, and work out what to write back.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SettingsRecord {
    /// Only the convars whose value changed.
    scalars: Vec<ScalarChange>,
    /// Only when the knife file's content changed.
    knife: Option<KnifeChange>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct ScalarChange {
    name: String,
    /// `None`: no line set it, so the plugin's default applied.
    before: Option<String>,
    after: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct KnifeChange {
    before: Knife,
    after: Knife,
    after_sha256: String,
    /// The file as the change wrote it, which Repair puts back when the file goes missing.
    after_text: String,
}

const RECORD: &str = "settings.json";

fn record_of(layout: &Layout, id: &str) -> Result<Option<SettingsRecord>, String> {
    let path = layout.backups().join(id).join(RECORD);
    match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Writes `values` into the server cfg and `knife` into the knife file, as one change named `op`,
/// each a compare-and-swap against `r`, and keeps the change's [`SettingsRecord`]. The server cfg
/// gains [`KNIFE_EXEC_LINE`] when the knife file is written and nothing in it runs the file yet.
fn write_settings(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, op: &str, r: &Read, values: &[(&str, String)], knife: Option<&Knife>) -> Result<Meta, String> {
    let mut server = if values.is_empty() { r.text.clone() } else { cfg::merge(&r.text, values) };
    let mut record = SettingsRecord::default();
    for (name, after) in values {
        let before = if r.hash.is_some() { scalar_in(&r.text, name) } else { None };
        if before.as_deref().unwrap_or(scalar_default(name)) != after {
            record.scalars.push(ScalarChange { name: name.to_string(), before, after: after.clone() });
        }
    }
    if let Some(k) = knife {
        let text = k.text(&r.other);
        if r.knife_text.as_deref() != Some(text.as_str()) {
            record.knife = Some(KnifeChange { before: r.knife.clone(), after: k.clone(), after_sha256: hash::bytes(text.as_bytes()), after_text: text });
        }
        if !cfg::execs(&server, KNIFE_EXEC) {
            let eol = if server.contains("\r\n") || r.hash.is_none() { "\r\n" } else { "\n" };
            if !server.is_empty() && !server.ends_with('\n') {
                server.push_str(eol);
            }
            server.push_str(KNIFE_EXEC_LINE);
            server.push_str(eol);
        }
    }
    let (_, meta) = changes::run(layout, probe, lock, op, |cs| {
        if server != r.text {
            cs.put_merged_cfg_if_unchanged(SERVER_CFG, server.as_bytes(), r.hash.as_deref())?;
        }
        if let Some(k) = &record.knife {
            cs.put_app_file_if_unchanged(KNIFE_CFG, k.after_text.as_bytes(), r.knife_hash.as_deref())?;
        }
        if !record.scalars.is_empty() || record.knife.is_some() {
            let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
            write_atomic(&cs.dir().join(RECORD), text.as_bytes())?;
        }
        Ok(())
    })?;
    Ok(meta)
}

/// The convar values `patch` sets.
fn values_of(patch: &ServerPatch) -> Vec<(&'static str, String)> {
    let flag = |b: bool| if b { "1" } else { "0" }.to_string();
    let mut values = Vec::new();
    if let Some(c) = patch.cosmetics {
        values.push((COSMETIC_CONVARS[0], flag(c.dropped_knife_skins)));
        values.push((COSMETIC_CONVARS[1], flag(c.dropped_knife_premium)));
        values.push((COSMETIC_CONVARS[2], c.music_kit.to_string()));
    }
    if let Some(a) = patch.bot_aim {
        values.push(("bot_aim", a.name().to_string()));
    }
    if let Some(n) = patch.bot_nades {
        values.push(("bot_nades", n.name().to_string()));
    }
    values
}

/// A knife change needs the knife file read: refused while it is missing or unreadable, so an
/// unknown set of keys is never taken for an empty one.
fn knife_known(file: &KnifeFile) -> Result<(), String> {
    match file.status {
        KnifeFileStatus::Missing => Err(format!("{KNIFE_CFG} is missing, so the keys Bot Mode keeps unbound are unknown; repair it first. Nothing was written.")),
        KnifeFileStatus::Unreadable => Err(format!("{}; nothing was written", file.error.as_deref().unwrap_or(KNIFE_CFG))),
        _ => Ok(()),
    }
}

/// Refuses a launch while the server cfg runs the knife file but the file is missing or can't be
/// read: which keys Bot Mode keeps unbound is then unknown, and a key the knife left would spawn
/// knives again. The message is the page's (`knifeProblem` in Setup.tsx). A server cfg that can't
/// be read leaves it unknown whether the file runs at all, so that is not refused here, as on the
/// page.
pub fn check_knife_file(layout: &Layout) -> Result<(), String> {
    let Ok(r) = read_all(layout) else { return Ok(()) };
    let f = &r.now.knife_file;
    let runs = r.hash.is_some() && cfg::execs(&r.text, KNIFE_EXEC);
    match f.status {
        KnifeFileStatus::Missing => Err(format!(
            "Knife key file missing: the server cfg runs {}, but it is gone, so which keys Bot Mode keeps unbound is unknown. Repair puts it back. Launch waits until then.",
            f.path
        )),
        KnifeFileStatus::Unreadable if runs => Err(format!(
            "The knife key file can't be read ({}), so which keys Bot Mode keeps unbound is unknown. Launch waits until then.",
            f.error.as_deref().unwrap_or(&f.path)
        )),
        _ => Ok(()),
    }
}

/// Applies `patch` as one change, refused (writing nothing) when the server cfg or the knife file
/// no longer holds `seen`, what the caller read. Each write is a compare-and-swap against the file
/// as read here, as in [`set_cosmetics_from`].
pub fn set_server(layout: &Layout, probe: &dyn ProcessProbe, patch: ServerPatch, seen: ServerSettings) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    if let Some(b) = &patch.knife_bind {
        b.check()?;
    }
    if let Some(k) = patch.stop_unbinding.iter().find(|k| check_key(k).is_err()) {
        return Err(format!("{k:?}: not a key name"));
    }
    let r = read_all(layout)?;
    if r.now != seen {
        return Err(format!("{SERVER_CFG}: the Bot Mode settings {}; nothing was written", changes::CHANGED_SINCE_READ));
    }
    // only a kit this change sets is checked: one already in the cfg (from an older catalog, or
    // with no catalog to check against) must not block a change to another setting
    if let Some(c) = patch.cosmetics.filter(|c| c.music_kit != r.now.cosmetics.music_kit) {
        check_music_kit(&layout.csgo, c.music_kit)?;
    }
    let knife = if patch.knife_bind.is_some() || !patch.stop_unbinding.is_empty() {
        knife_known(&r.now.knife_file)?;
        Some(r.knife.after(&patch))
    } else {
        None
    };
    write_settings(layout, probe, &lock, "server-cfg", &r, &values_of(&patch), knife.as_ref())
}

/// What Undo of a settings change would write, for the view's preview.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoPlan {
    pub change: String,
    /// The lines Undo sets in the server cfg.
    pub server_lines: Vec<String>,
    /// The knife file as Undo writes it, whole; `None` when the change did not write it.
    pub knife_lines: Option<Vec<String>>,
    /// Why Undo would refuse: a setting changed since the change. `None` when it can run.
    pub refused: Option<String>,
}

struct Undo {
    read: Read,
    values: Vec<(String, String)>,
    knife: Option<Knife>,
    refused: Option<String>,
}

/// Works out the undo of change `id` from its [`SettingsRecord`]: each convar back to its value
/// before the change, and the knife key by [`Knife::undo`]. Refused unless the knife file still
/// hashes to what the change wrote and every convar it touched still holds the value it wrote:
/// otherwise Undo would overwrite a later edit, by the user or another tool.
fn prepare_undo(layout: &Layout, id: &str) -> Result<Undo, String> {
    let meta = changes::list(layout)?.into_iter().find(|m| m.id == id).ok_or_else(|| format!("{id}: no such change"))?;
    if meta.status != changes::Status::Complete {
        return Err(format!("{id} is not in effect ({:?}), so there is nothing of it to undo", meta.status));
    }
    let record = record_of(layout, id)?.ok_or_else(|| format!("{id} kept no record of the settings it changed, so it can only be rolled back"))?;
    let read = read_all(layout)?;
    let mut changed = Vec::new();
    for s in &record.scalars {
        let now = if read.hash.is_some() { scalar_in(&read.text, &s.name) } else { None };
        let shown = now.clone().unwrap_or_else(|| format!("unset, so {}", scalar_default(&s.name)));
        if now.as_deref().unwrap_or(scalar_default(&s.name)) != s.after {
            changed.push(format!("{} (now {shown})", s.name));
        }
    }
    if let Some(k) = &record.knife {
        if read.knife_hash.as_deref() != Some(k.after_sha256.as_str()) {
            let how = match read.now.knife_file.status {
                KnifeFileStatus::None | KnifeFileStatus::Missing => "now missing",
                _ => "edited since",
            };
            changed.push(format!("{KNIFE_CFG} ({how})"));
        }
    }
    let refused = (!changed.is_empty()).then(|| {
        format!(
            "{} changed since this change, so Undo would overwrite {}. Nothing was written.",
            changed.join(", "),
            if changed.len() == 1 { "it" } else { "them" }
        )
    });
    let values = record.scalars.iter().map(|s| (s.name.clone(), s.before.clone().unwrap_or_else(|| scalar_default(&s.name).to_string()))).collect();
    let knife = record.knife.as_ref().map(|k| Knife::undo(&k.before, &k.after));
    Ok(Undo { read, values, knife, refused })
}

/// The preview of [`undo_server`]; reads only.
pub fn undo_plan(layout: &Layout, id: &str) -> Result<UndoPlan, String> {
    let u = prepare_undo(layout, id)?;
    let mut server_lines: Vec<String> = u.values.iter().map(|(n, v)| format!("{n} {v}")).collect();
    if u.knife.is_some() && !(u.read.hash.is_some() && cfg::execs(&u.read.text, KNIFE_EXEC)) {
        server_lines.push(KNIFE_EXEC_LINE.into());
    }
    let knife_lines = u.knife.as_ref().map(|k| k.text(&u.read.other).lines().map(str::to_string).collect());
    Ok(UndoPlan { change: id.into(), server_lines, knife_lines, refused: u.refused })
}

/// Undoes settings change `id` as a new change forward ("server-cfg-undo"), which keeps its own
/// record, so it can be undone in turn. Refused, writing nothing, as [`prepare_undo`] says.
pub fn undo_server(layout: &Layout, probe: &dyn ProcessProbe, id: &str) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let u = prepare_undo(layout, id)?;
    if let Some(why) = u.refused {
        return Err(why);
    }
    let values: Vec<(&str, String)> = u.values.iter().map(|(n, v)| (n.as_str(), v.clone())).collect();
    write_settings(layout, probe, &lock, "server-cfg-undo", &u.read, &values, u.knife.as_ref())
}

/// What Repair writes when the knife file is missing.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    /// The change whose knife file Repair puts back; `None` when no change recorded one, and
    /// Repair writes the mod's own key with no keys unbound.
    pub from: Option<String>,
    pub lines: Vec<String>,
}

fn repair_source(layout: &Layout) -> Result<RepairPlan, String> {
    let r = read_all(layout)?;
    if r.now.knife_file.status != KnifeFileStatus::Missing {
        return Err(format!("{KNIFE_CFG} is not missing; nothing to repair"));
    }
    for m in changes::list(layout)?.into_iter().filter(|m| m.status == changes::Status::Complete) {
        if let Some(k) = record_of(layout, &m.id)?.and_then(|r| r.knife) {
            return Ok(RepairPlan { from: Some(m.id), lines: k.after_text.lines().map(str::to_string).collect() });
        }
    }
    let fallback = Knife { bind: Some(KnifeBind::of_mod()), unbound: Vec::new() };
    Ok(RepairPlan { from: None, lines: fallback.text(&[]).lines().map(str::to_string).collect() })
}

/// The preview of [`repair_knife`]; reads only.
pub fn knife_repair_plan(layout: &Layout) -> Result<RepairPlan, String> {
    repair_source(layout)
}

/// Writes the missing knife file back as the newest change that wrote it left it (see
/// [`RepairPlan`]), refused unless `seen` is still that plan and the file is still missing.
pub fn repair_knife(layout: &Layout, probe: &dyn ProcessProbe, seen: &RepairPlan) -> Result<Meta, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let plan = repair_source(layout)?;
    if plan != *seen {
        return Err(format!("{KNIFE_CFG}: what Repair would write {}; nothing was written", changes::CHANGED_SINCE_READ));
    }
    let mut text = plan.lines.join("\r\n");
    text.push_str("\r\n");
    let (_, meta) = changes::run(layout, probe, &lock, "knife-repair", |cs| cs.put_app_file_if_unchanged(KNIFE_CFG, text.as_bytes(), None))?;
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
