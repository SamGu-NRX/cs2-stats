//! Downloading and installing an official CS2-Bot-Improver release.
//!
//! The README's Windows steps are: extract `CS2BotImprover.zip`, move the Panel executable
//! out, and copy the remaining files into `game\csgo`. Install does that, with four
//! differences, each for a reason given where it happens:
//! - The Panel executable (any `.exe` at the zip's root) is not installed.
//! - The root `gameinfo.gi` is not copied; its two search paths are merged into the game's
//!   own file instead (see `gameinfo.rs`).
//! - Protected user files are kept or merged (see `paths::Protection`).
//! - The active bot profile keeps the difficulty the user had chosen.

use super::changes::{self, Meta};
use super::gameinfo;
use super::github;
use super::hash;
use super::paths::{self, Layout, Protection};
use super::process::{ensure_cs2_closed, ProcessProbe};
use super::settings::{self, Difficulty, ACTIVE_PROFILE, COSMETIC_CONVARS};
use super::state::{self, Official, SourceLink};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const OFFICIAL_REPO: &str = "ed0ard/CS2-Bot-Improver";
pub const DEFAULT_ASSET: &str = "CS2BotImprover.zip";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

/// What a downloaded release zip contains, stored next to it as `<asset>.index.json` so
/// status can compare the game folder against it without unpacking the zip again.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseIndex {
    pub tag: String,
    pub asset: String,
    pub sha256: String,
    pub source: SourceLink,
    /// Files install copies, by game path.
    pub files: BTreeMap<String, String>,
    pub skipped: Vec<Skipped>,
    /// The search paths the release's `backup\WithBots` copy adds to `backup\Online`.
    pub bot_search_paths: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Cached {
    pub index: ReleaseIndex,
    pub zip: PathBuf,
}

fn index_path(zip: &Path) -> PathBuf {
    let mut name = zip.file_name().unwrap_or_default().to_os_string();
    name.push(".index.json");
    zip.with_file_name(name)
}

/// Fetches the release metadata, downloads and verifies the asset (reusing a verified copy),
/// and writes its index. Touches only the app's folder, never the game.
pub fn download(layout: &Layout, tag: &str, asset_name: &str, sha_override: Option<&str>) -> Result<Cached, String> {
    github::check_name("tag", tag)?;
    github::check_name("asset name", asset_name)?;
    let release = github::release(OFFICIAL_REPO, tag)?;
    let asset = release.assets.iter().find(|a| a.name == asset_name).ok_or_else(|| {
        let names: Vec<_> = release.assets.iter().map(|a| a.name.as_str()).collect();
        format!("{tag} has no asset {asset_name}; it has {}", names.join(", "))
    })?;
    let sha = asset.sha256(sha_override)?;
    let zip = layout.releases().join(tag).join(asset_name);
    github::download_verified(asset, &sha, &zip)?;
    let commit = github::tag_commit(OFFICIAL_REPO, tag)?;
    let source = SourceLink::new(&format!("https://github.com/{OFFICIAL_REPO}"), tag, Some(commit));
    let index = index_zip(&zip, tag, asset_name, &sha, source)?;
    let text = serde_json::to_string_pretty(&index).map_err(|e| e.to_string())?;
    changes::write_atomic(&index_path(&zip), text.as_bytes())?;
    Ok(Cached { index, zip })
}

/// Every downloaded release with a readable index.
pub fn cached_all(layout: &Layout) -> Vec<Cached> {
    let mut out = Vec::new();
    let Ok(tags) = std::fs::read_dir(layout.releases()) else { return out };
    for tag in tags.flatten() {
        let Ok(files) = std::fs::read_dir(tag.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else { continue };
            if let Some(zip_name) = name.strip_suffix(".index.json") {
                let zip = p.with_file_name(zip_name);
                let index = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<ReleaseIndex>(&t).ok());
                if let (Some(index), true) = (index, zip.is_file()) {
                    out.push(Cached { index, zip });
                }
            }
        }
    }
    out.sort_by(|a, b| b.index.tag.cmp(&a.index.tag));
    out
}

pub fn cached(layout: &Layout, tag: &str, asset: &str) -> Option<Cached> {
    cached_all(layout).into_iter().find(|c| c.index.tag == tag && c.index.asset == asset)
}

fn open(zip: &Path) -> Result<zip::ZipArchive<File>, String> {
    let f = File::open(zip).map_err(|e| format!("{}: {e}", zip.display()))?;
    zip::ZipArchive::new(f).map_err(|e| format!("{}: {e}", zip.display()))
}

/// Game path of each file entry, by lowercase path, with its index in the archive.
fn entries(archive: &mut zip::ZipArchive<File>) -> Result<HashMap<String, (String, usize)>, String> {
    let mut out = HashMap::new();
    for i in 0..archive.len() {
        let e = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if e.is_dir() {
            continue;
        }
        let raw = e.name().to_string();
        if e.enclosed_name().is_none() {
            return Err(format!("{raw}: unsafe path in the zip"));
        }
        let rel = paths::rel(&raw)?;
        if out.insert(rel.to_ascii_lowercase(), (rel.clone(), i)).is_some() {
            return Err(format!("{rel}: listed twice in the zip"));
        }
    }
    Ok(out)
}

fn read_text(archive: &mut zip::ZipArchive<File>, map: &HashMap<String, (String, usize)>, rel: &str) -> Result<Option<String>, String> {
    let Some((_, i)) = map.get(&rel.to_ascii_lowercase()) else { return Ok(None) };
    let mut s = String::new();
    archive
        .by_index(*i)
        .map_err(|e| e.to_string())?
        .read_to_string(&mut s)
        .map_err(|e| format!("{rel}: {e}"))?;
    Ok(Some(s))
}

/// Reads a release zip: hashes every file install would copy and records what it skips.
pub fn index_zip(zip: &Path, tag: &str, asset: &str, sha256: &str, source: SourceLink) -> Result<ReleaseIndex, String> {
    let mut archive = open(zip)?;
    let map = entries(&mut archive)?;
    let online = read_text(&mut archive, &map, "backup/Online/gameinfo.gi")?;
    let with_bots = read_text(&mut archive, &map, "backup/WithBots/gameinfo.gi")?;
    let (Some(online), Some(with_bots)) = (online, with_bots) else {
        return Err(format!("{asset}: no backup/Online and backup/WithBots gameinfo.gi, so how this release turns Bot Mode on is unknown"));
    };
    let bot_search_paths = gameinfo::added_search_paths(&online, &with_bots)?;
    let expected: Vec<String> = gameinfo::BOT_SEARCH_PATHS.iter().map(|p| format!("Game {p}")).collect();
    let same = bot_search_paths.len() == expected.len()
        && bot_search_paths.iter().zip(&expected).all(|(a, b)| a.eq_ignore_ascii_case(b));
    if !same {
        return Err(format!(
            "{asset}: Bot Mode in this release adds the search paths [{}], not the [{}] this app knows how to merge",
            bot_search_paths.join(", "),
            expected.join(", ")
        ));
    }
    let mut files = BTreeMap::new();
    let mut skipped = Vec::new();
    let mut sorted: Vec<_> = map.values().cloned().collect();
    sorted.sort();
    for (rel, i) in sorted {
        if !rel.contains('/') && rel.to_ascii_lowercase().ends_with(".exe") {
            skipped.push(Skipped { path: rel, reason: "the Panel; Bot Mode replaces it and does not install it".into() });
            continue;
        }
        if rel.eq_ignore_ascii_case("gameinfo.gi") {
            skipped.push(Skipped { path: rel, reason: "not copied; its two Bot Mode search paths are merged into the game's gameinfo.gi".into() });
            continue;
        }
        let e = archive.by_index(i).map_err(|e| e.to_string())?;
        let digest = hash::reader(e).map_err(|e| format!("{rel}: {e}"))?;
        files.insert(rel, digest);
    }
    Ok(ReleaseIndex { tag: tag.into(), asset: asset.into(), sha256: sha256.into(), source, files, skipped, bot_search_paths })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub change: Meta,
    #[serde(flatten)]
    pub summary: InstallSummary,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallSummary {
    pub tag: String,
    pub asset: String,
    pub source: SourceLink,
    /// Files whose content changed.
    pub written: usize,
    /// Files that already matched the release.
    pub unchanged: usize,
    pub skipped: Vec<Skipped>,
    /// Protected files in the release that were not written.
    pub kept: Vec<String>,
    /// Protected cfgs the release ships, merged into the user's copy.
    pub merged: Vec<String>,
    pub bot_mode_enabled: bool,
    pub difficulty_kept: Option<Difficulty>,
    /// Overlays whose files the release replaced; `botmode overlay` puts them back.
    pub overlays_replaced: Vec<String>,
}

/// Installs a downloaded release. Every write is backed up; any failure rolls the whole
/// install back.
pub fn install(layout: &Layout, probe: &dyn ProcessProbe, cached: &Cached) -> Result<InstallReport, String> {
    ensure_cs2_closed(probe)?;
    let index = &cached.index;
    let zip_sha = hash::file(&cached.zip)?;
    if zip_sha != index.sha256 {
        return Err(format!("{}: changed since it was verified (SHA-256 {zip_sha}); download it again", cached.zip.display()));
    }
    let mut archive = open(&cached.zip)?;
    let map = entries(&mut archive)?;
    let level = settings::current_difficulty(&layout.csgo)?;

    let op = format!("install-{}", index.tag);
    let body = |cs: &mut changes::ChangeSet| -> Result<InstallSummary, String> {
        let (mut written, mut unchanged) = (0, 0);
        let (mut kept, mut merged) = (Vec::new(), Vec::new());
        let mut installed = BTreeMap::new();
        for (rel, digest) in &index.files {
            match paths::protection(rel) {
                Protection::Keep => {
                    kept.push(rel.clone());
                    continue;
                }
                Protection::MergeConvars => {
                    let incoming = read_text(&mut archive, &map, rel)?.unwrap_or_default();
                    let path = layout.target(rel);
                    let user = match std::fs::read_to_string(&path) {
                        Ok(t) => t,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                        Err(e) => return Err(format!("{}: {e}", path.display())),
                    };
                    let out = super::cfg::add_missing(&user, &incoming, &COSMETIC_CONVARS);
                    if out != user {
                        cs.put_merged_cfg(rel, out.as_bytes())?;
                    }
                    merged.push(rel.clone());
                    continue;
                }
                Protection::None => {}
            }
            // The release ships Medium as the active profile; keep the user's level instead.
            let (source_rel, digest) = match level {
                Some(l) if rel.eq_ignore_ascii_case(ACTIVE_PROFILE) => match index.files.get(l.variant()) {
                    Some(d) => (l.variant().to_string(), d),
                    None => (rel.clone(), digest),
                },
                _ => (rel.clone(), digest),
            };
            let (_, i) = *map
                .get(&source_rel.to_ascii_lowercase())
                .ok_or_else(|| format!("{source_rel}: in the index but not in the zip"))?;
            let changed = cs.put(rel, digest, |f| {
                let e = archive.by_index(i).map_err(|e| e.to_string())?;
                hash::copy(e, f).map(|_| ()).map_err(|e| format!("{source_rel}: {e}"))
            })?;
            if changed {
                written += 1;
            } else {
                unchanged += 1;
            }
            installed.insert(rel.clone(), digest.clone());
        }

        let gi = layout.target("gameinfo.gi");
        let text = std::fs::read_to_string(&gi).map_err(|e| format!("{}: {e}", gi.display()))?;
        let on = gameinfo::enable(&text)?;
        let bot_mode_enabled = on != text;
        if bot_mode_enabled {
            cs.put_bytes("gameinfo.gi", on.as_bytes())?;
        }

        let mut st = state::load(layout)?;
        let overlays_replaced: Vec<String> = st
            .overlays
            .iter()
            .filter(|o| o.files.iter().any(|(p, d)| installed.get(p).is_some_and(|new| new != d)))
            .map(|o| o.name.clone())
            .collect();
        st.overlays.retain(|o| !overlays_replaced.contains(&o.name));
        st.official = Some(Official {
            tag: index.tag.clone(),
            asset: index.asset.clone(),
            sha256: index.sha256.clone(),
            source: index.source.clone(),
            installed_at: changes::now_utc().1,
            files: installed,
        });
        state::save(layout, &st)?;
        Ok(InstallSummary {
            tag: index.tag.clone(),
            asset: index.asset.clone(),
            source: index.source.clone(),
            written,
            unchanged,
            skipped: index.skipped.clone(),
            kept,
            merged,
            bot_mode_enabled,
            difficulty_kept: level,
            overlays_replaced,
        })
    };
    let (summary, change) = changes::run(layout, probe, &op, body)?;
    Ok(InstallReport { change, summary })
}
