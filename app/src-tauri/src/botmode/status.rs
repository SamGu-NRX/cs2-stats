//! The read-only report: where CS2 is, which mod version is installed, each component's
//! hashes and state, the protected user files, settings and backups.

use super::changes::{self, Meta};
use super::components;
use super::gameinfo;
use super::hash;
use super::install;
use super::paths::{self, Layout, Protection};
use super::process::ProcessProbe;
use super::settings::{self, CosmeticsState};
use super::state::{self, OverlayRecord, SourceLink};
use super::steam::Cs2Install;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ComponentState {
    /// Every file matches the reference release.
    Official,
    /// Files match the release or a recorded overlay, and at least one is an overlay.
    Overlay,
    /// Some file differs from both, or a release file is missing.
    Modified,
    /// Not in the reference release (for example BotMatchStats when it was copied by hand).
    NotInRelease,
    /// No reference release to compare with.
    Unknown,
    /// In the release but no file is present.
    Missing,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub name: String,
    pub state: ComponentState,
    /// Combined SHA-256 of the files present (see `hash::combined`).
    pub sha256: Option<String>,
    pub files: BTreeMap<String, String>,
    /// Present files whose hash differs from the release and from any overlay.
    pub differs: Vec<String>,
    /// Release files that are not present.
    pub missing: Vec<String>,
    /// The overlay that supplied files here, with its source link.
    pub overlay: Option<SourceLink>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    /// Set when this app installed the release.
    pub installed: Option<InstalledRelease>,
    /// The release the files were compared with: the installed one, or else the downloaded
    /// release that matches the most files.
    pub reference: Option<String>,
    pub matching: usize,
    pub total: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRelease {
    pub tag: String,
    pub asset: String,
    pub installed_at: String,
    pub source: SourceLink,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub csgo: String,
    pub steam: Option<String>,
    pub build_id: Option<String>,
    pub cs2_running: Option<bool>,
    pub bot_mode: Option<bool>,
    pub release: ReleaseStatus,
    pub difficulty: Option<settings::Difficulty>,
    pub cosmetics: CosmeticsState,
    /// Launch options set for CS2 in Steam, which Steam adds to every start.
    pub steam_launch_options: Option<String>,
    /// The app's own launch options, added after `-insecure`.
    pub launch_options: String,
    pub components: Vec<Component>,
    /// Protected user files and their hashes. Bot Mode never replaces them.
    pub protected: BTreeMap<String, String>,
    pub overlays: Vec<OverlayRecord>,
    pub backups: Vec<Meta>,
    /// Problems found while reading, each a full sentence.
    pub warnings: Vec<String>,
}

fn classify(
    name: &str,
    present: Option<&BTreeMap<String, String>>,
    reference: Option<&BTreeMap<String, String>>,
    overlays: &[OverlayRecord],
) -> Component {
    let empty = BTreeMap::new();
    let files = present.unwrap_or(&empty).clone();
    let mut differs = Vec::new();
    let mut overlay = None;
    let mut official = 0;
    for (rel, digest) in &files {
        if let Some(o) = overlays.iter().find(|o| o.files.get(rel) == Some(digest)) {
            overlay = Some(o.source.clone());
        } else if reference.and_then(|r| r.get(rel)) == Some(digest) {
            official += 1;
        } else if reference.is_some_and(|r| r.contains_key(rel)) {
            differs.push(rel.clone());
        }
    }
    let in_release: Vec<&String> = reference
        .map(|r| r.keys().filter(|k| components::owner(k).as_deref() == Some(name)).collect())
        .unwrap_or_default();
    let missing: Vec<String> = in_release.iter().filter(|k| !files.contains_key(**k)).map(|k| k.to_string()).collect();
    let state = if files.is_empty() {
        ComponentState::Missing
    } else if reference.is_none() && overlay.is_none() {
        ComponentState::Unknown
    } else if !differs.is_empty() || !missing.is_empty() {
        ComponentState::Modified
    } else if overlay.is_some() {
        ComponentState::Overlay
    } else if in_release.is_empty() || official == 0 {
        ComponentState::NotInRelease
    } else {
        ComponentState::Official
    };
    let sha256 = (!files.is_empty()).then(|| hash::combined(&files));
    Component { name: name.into(), state, sha256, files, differs, missing, overlay }
}

/// Builds the report. Reads only; writes nothing anywhere.
pub fn status(layout: &Layout, probe: &dyn ProcessProbe, install: Option<&Cs2Install>, steam_launch_options: Option<String>) -> Result<Status, String> {
    let mut warnings = Vec::new();
    let cs2_running = match probe.cs2_running() {
        Ok(r) => Some(r),
        Err(e) => {
            warnings.push(format!("Could not check whether CS2 is running: {e}."));
            None
        }
    };
    let gi = layout.target("gameinfo.gi");
    let bot_mode = match std::fs::read_to_string(&gi).map_err(|e| e.to_string()).and_then(|t| gameinfo::is_bot_mode(&t)) {
        Ok(b) => Some(b),
        Err(e) => {
            warnings.push(format!("Could not read {}: {e}.", gi.display()));
            None
        }
    };
    let st = state::load(layout)?;
    let present = components::scan(&layout.csgo)?;
    let all_present: BTreeMap<&String, &String> = present.values().flat_map(|m| m.iter()).collect();

    let (reference, release) = match &st.official {
        Some(o) => {
            let matching = o.files.iter().filter(|(k, v)| all_present.get(k) == Some(v)).count();
            let rs = ReleaseStatus {
                installed: Some(InstalledRelease { tag: o.tag.clone(), asset: o.asset.clone(), installed_at: o.installed_at.clone(), source: o.source.clone() }),
                reference: Some(o.tag.clone()),
                matching,
                total: o.files.len(),
            };
            (Some(o.files.clone()), rs)
        }
        None => {
            // Protected files are the user's, so they say nothing about the installed version.
            let best = install::cached_all(layout)
                .into_iter()
                .map(|c| {
                    let files: BTreeMap<String, String> =
                        c.index.files.into_iter().filter(|(k, _)| paths::protection(k) == Protection::None).collect();
                    let n = files.iter().filter(|(k, v)| all_present.get(k) == Some(v)).count();
                    (n, format!("{} ({})", c.index.tag, c.index.asset), files)
                })
                .max_by_key(|(n, _, _)| *n);
            match best {
                Some((n, label, files)) if n > 0 => {
                    let rs = ReleaseStatus { installed: None, reference: Some(label), matching: n, total: files.len() };
                    (Some(files), rs)
                }
                _ => (None, ReleaseStatus { installed: None, reference: None, matching: 0, total: 0 }),
            }
        }
    };

    let mut names: Vec<String> = present.keys().cloned().collect();
    if let Some(r) = &reference {
        names.extend(r.keys().filter_map(|k| components::owner(k)));
    }
    names.sort();
    names.dedup();
    let comps: Vec<Component> = names
        .iter()
        .map(|n| classify(n, present.get(n), reference.as_ref(), &st.overlays))
        .collect();

    let steam_has_insecure = steam_launch_options
        .as_deref()
        .is_some_and(|o| o.split_whitespace().any(|a| a.eq_ignore_ascii_case("-insecure")));
    if bot_mode == Some(true) && !steam_has_insecure {
        warnings.push("Bot Mode is on in gameinfo.gi, but CS2's launch options in Steam lack -insecure: starting the game from Steam would load the mod with VAC on. Start it with `botmode launch`.".into());
    }
    let app = settings::load_app(layout)?;
    Ok(Status {
        csgo: layout.csgo.display().to_string(),
        steam: install.map(|i| i.steam.display().to_string()),
        build_id: install.and_then(|i| i.build_id.clone()),
        cs2_running,
        bot_mode,
        release,
        difficulty: settings::current_difficulty(&layout.csgo)?,
        cosmetics: settings::read_cosmetics(&layout.csgo)?,
        steam_launch_options,
        launch_options: app.launch_options,
        components: comps,
        protected: components::protected(&layout.csgo)?,
        overlays: st.overlays,
        backups: changes::list(layout)?,
        warnings,
    })
}

fn yes_no(b: Option<bool>, yes: &str, no: &str) -> String {
    match b {
        Some(true) => yes.into(),
        Some(false) => no.into(),
        None => "unknown".into(),
    }
}

fn short(s: &str) -> &str {
    &s[..12.min(s.len())]
}

/// The report as text for the terminal.
pub fn render(s: &Status) -> String {
    let mut o = String::new();
    let mut line = |k: &str, v: String| o.push_str(&format!("{k:<22}{v}\n"));
    line("CS2", s.csgo.clone());
    if let Some(b) = &s.build_id {
        line("Steam build", b.clone());
    }
    line("CS2 running", yes_no(s.cs2_running, "yes", "no"));
    line("Bot Mode (gameinfo)", yes_no(s.bot_mode, "on", "off"));
    let release = match (&s.release.installed, &s.release.reference) {
        (Some(i), _) => format!("{} ({}), installed by this app {}; {} of {} files match", i.tag, i.asset, i.installed_at, s.release.matching, s.release.total),
        (None, Some(r)) => format!("not installed by this app; {} of {} files match downloaded {r}", s.release.matching, s.release.total),
        (None, None) => "unknown: not installed by this app and no release downloaded to compare (`botmode download <tag>`)".into(),
    };
    line("Mod release", release);
    if let Some(i) = &s.release.installed {
        line("Release source", i.source.url.clone());
    }
    line("Difficulty", s.difficulty.map_or("custom or missing bot profile".into(), |d| d.name().to_string()));
    let c = &s.cosmetics;
    line(
        "Cosmetics",
        format!(
            "br_dropped_knife_skins {} | br_dropped_knife_premium {} | br_player_music_kit {}{}",
            u8::from(c.cosmetics.dropped_knife_skins),
            u8::from(c.cosmetics.dropped_knife_premium),
            c.cosmetics.music_kit,
            if c.cfg_present { "" } else { " (no gamemode_competitive_server.cfg; plugin defaults)" }
        ),
    );
    line("Steam launch options", s.steam_launch_options.clone().unwrap_or_else(|| "(none found)".into()));
    line("Bot Mode launch", format!("steam.exe -applaunch 730 -insecure {}", s.launch_options).trim_end().to_string());

    o.push_str("\nComponents\n");
    o.push_str(&format!("  {:<22}{:>6}  {:<13}{:<14}{}\n", "name", "files", "state", "sha256", "notes"));
    for comp in &s.components {
        let state = format!("{:?}", comp.state);
        let mut notes = Vec::new();
        if let Some(src) = &comp.overlay {
            notes.push(format!("overlay {}", src.url));
        }
        if !comp.differs.is_empty() {
            notes.push(format!("{} differ: {}", comp.differs.len(), comp.differs.iter().take(3).cloned().collect::<Vec<_>>().join(", ")));
        }
        if !comp.missing.is_empty() {
            notes.push(format!("{} missing", comp.missing.len()));
        }
        o.push_str(&format!(
            "  {:<22}{:>6}  {:<13}{:<14}{}\n",
            comp.name,
            comp.files.len(),
            state,
            comp.sha256.as_deref().map_or("-", short),
            notes.join("; ")
        ));
    }
    o.push_str("\nProtected user files (never replaced)\n");
    if s.protected.is_empty() {
        o.push_str("  (none)\n");
    }
    for (p, h) in &s.protected {
        o.push_str(&format!("  {p}  {}\n", short(h)));
    }
    if !s.overlays.is_empty() {
        o.push_str("\nOverlays applied by this app\n");
        for ov in &s.overlays {
            o.push_str(&format!("  {:<16}{} files  {}  ({})\n", ov.name, ov.files.len(), ov.source.url, ov.applied_at));
        }
    }
    o.push_str("\nBackups\n");
    if s.backups.is_empty() {
        o.push_str("  (none)\n");
    }
    for b in s.backups.iter().take(10) {
        o.push_str(&format!("  {}  {:?}, {} files\n", b.id, b.status, b.files));
    }
    if !s.warnings.is_empty() {
        o.push_str("\nWarnings\n");
        for w in &s.warnings {
            o.push_str(&format!("  {w}\n"));
        }
    }
    o
}
