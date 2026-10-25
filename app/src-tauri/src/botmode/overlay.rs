//! The overlay: the user's own plugin builds, copied over the official release.
//!
//! The set lives in a manifest file (`overlay.json` in the app's Bot Mode folder; a
//! copy of the user's set is `botmode/overlay.example.json` in this crate). Each
//! entry names a plugin folder under `addons\`, the files to copy into it, and where they
//! come from:
//! - `local`: a build folder inside a git checkout. The checkout must be on the named
//!   branch, have no uncommitted changes to tracked files, and have its commit on a remote
//!   branch, so the recorded source link points at the code that was built.
//! - `github-release`: a zip attached to a GitHub release, verified like the official one.
//!
//! Every entry is resolved and verified before the first file is written.

use super::changes::{self, Meta};
use super::github;
use super::hash;
use super::paths::{self, Layout, Protection};
use super::process::{ensure_cs2_closed, ProcessProbe};
use super::state::{self, OverlayRecord, SourceLink};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const EXAMPLE: &str = include_str!("../../botmode/overlay.example.json");

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub entries: Vec<Entry>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub name: String,
    /// Plugin folder relative to `game\csgo`, under `addons/`.
    pub target: String,
    /// File names copied from the source into `target`.
    pub files: Vec<String>,
    pub source: Source,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Source {
    #[serde(rename_all = "camelCase")]
    Local {
        /// "owner/name" on GitHub, where the branch is published.
        repo: String,
        branch: String,
        /// The git checkout. `%NAME%` environment references are expanded.
        checkout: String,
        /// The build output folder, relative to `checkout` or absolute.
        build: String,
    },
    #[serde(rename_all = "camelCase")]
    GithubRelease {
        repo: String,
        tag: String,
        asset: String,
        /// Folder inside the zip holding `files`; the zip's root when absent.
        #[serde(default)]
        subdir: Option<String>,
        /// Expected SHA-256, for an asset GitHub publishes no digest for.
        #[serde(default)]
        sha256: Option<String>,
    },
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_str(text).map_err(|e| format!("overlay manifest: {e}"))?;
        if m.version != 1 {
            return Err(format!("overlay manifest: version {} is not supported (expected 1)", m.version));
        }
        let mut names = HashSet::new();
        let mut targets = HashSet::new();
        for e in &m.entries {
            let fail = |why: String| Err(format!("overlay manifest, entry {}: {why}", e.name));
            if e.name.trim().is_empty() || !names.insert(e.name.to_ascii_lowercase()) {
                return fail("names must be unique and not empty".into());
            }
            let target = paths::rel(&e.target)?;
            if !target.to_ascii_lowercase().starts_with("addons/") || paths::protection(&format!("{target}/x")) != Protection::None {
                return fail(format!("target {target} must be a plugin folder under addons/"));
            }
            if !targets.insert(target.to_ascii_lowercase()) {
                return fail(format!("target {target} is used by two entries"));
            }
            if e.files.is_empty() {
                return fail("lists no files".into());
            }
            let mut seen = HashSet::new();
            for f in &e.files {
                if f.contains(['/', '\\', ':']) || f == "." || f == ".." || f.is_empty() || !seen.insert(f.to_ascii_lowercase()) {
                    return fail(format!("{f:?} must be a plain, unique file name"));
                }
            }
            match &e.source {
                Source::Local { repo, branch, .. } => {
                    github::check_repo(repo)?;
                    if branch.trim().is_empty() {
                        return fail("names no branch".into());
                    }
                }
                Source::GithubRelease { repo, tag, asset, subdir, .. } => {
                    github::check_repo(repo)?;
                    github::check_name("tag", tag)?;
                    github::check_name("asset name", asset)?;
                    if let Some(d) = subdir {
                        paths::rel(d)?;
                    }
                }
            }
        }
        Ok(m)
    }

    pub fn load(path: &Path) -> Result<Manifest, String> {
        let text = std::fs::read_to_string(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{} does not exist; create it with `botmode init-manifest` and edit it", path.display()),
            _ => format!("{}: {e}", path.display()),
        })?;
        Manifest::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
    }
}

enum Content {
    File(PathBuf),
    Bytes(Vec<u8>),
}

struct ResolvedFile {
    rel: String,
    sha: String,
    content: Content,
}

struct Resolved {
    name: String,
    target: String,
    files: Vec<ResolvedFile>,
    source: SourceLink,
    warnings: Vec<String>,
}

fn git(checkout: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(args)
        .output()
        .map_err(|e| format!("running git in {}: {e}", checkout.display()))?;
    if !out.status.success() {
        return Err(format!("git {} in {}: {}", args.join(" "), checkout.display(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn resolve_local(e: &Entry, repo: &str, branch: &str, checkout: &str, build: &str) -> Result<Resolved, String> {
    let checkout = paths::expand_env(checkout)?;
    let build_dir = {
        let b = paths::expand_env(build)?;
        if b.is_absolute() { b } else { checkout.join(b) }
    };
    let on = git(&checkout, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if on != *branch {
        return Err(format!("{}: {} is on branch {on}, but the manifest names {branch}", e.name, checkout.display()));
    }
    let commit = git(&checkout, &["rev-parse", "HEAD"])?;
    if !git(&checkout, &["status", "--porcelain", "--untracked-files=no"])?.is_empty() {
        return Err(format!(
            "{}: {} has uncommitted changes, so commit {} would not be the source of this build",
            e.name,
            checkout.display(),
            &commit[..12.min(commit.len())]
        ));
    }
    if git(&checkout, &["branch", "-r", "--contains", "HEAD"])?.is_empty() {
        return Err(format!(
            "{}: commit {} is not on any remote branch; push it so the source link resolves",
            e.name,
            &commit[..12.min(commit.len())]
        ));
    }
    let committed: u64 = git(&checkout, &["log", "-1", "--format=%ct"])?.parse().unwrap_or(0);
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    for f in &e.files {
        let path = build_dir.join(f);
        let sha = hash::file_if_exists(&path)?.ok_or_else(|| format!("{}: {} not found; build the plugin first", e.name, path.display()))?;
        let built = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        if f.to_ascii_lowercase().ends_with(".dll") && built < committed {
            warnings.push(format!("{f} was built before commit {} was made; rebuild if that commit changed code", &commit[..12]));
        }
        files.push(ResolvedFile { rel: format!("{}/{f}", e.target), sha, content: Content::File(path) });
    }
    Ok(Resolved {
        name: e.name.clone(),
        target: e.target.clone(),
        files,
        source: SourceLink::new(&format!("https://github.com/{repo}"), branch, Some(commit)),
        warnings,
    })
}

fn resolve_release(layout: &Layout, e: &Entry, repo: &str, tag: &str, asset: &str, subdir: Option<&str>, sha: Option<&str>) -> Result<Resolved, String> {
    let release = github::release(repo, tag)?;
    let a = release
        .assets
        .iter()
        .find(|a| a.name == asset)
        .ok_or_else(|| format!("{}: release {tag} of {repo} has no asset {asset}", e.name))?;
    let expected = a.sha256(sha)?;
    let zip_path = layout.artifacts().join(repo.replace('/', "_")).join(tag).join(asset);
    github::download_verified(a, &expected, &zip_path)?;
    let commit = github::tag_commit(repo, tag)?;
    let f = std::fs::File::open(&zip_path).map_err(|err| format!("{}: {err}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|err| format!("{}: {err}", zip_path.display()))?;
    let mut files = Vec::new();
    for name in &e.files {
        let inner = match subdir {
            Some(d) => format!("{}/{name}", paths::rel(d)?),
            None => name.clone(),
        };
        let mut entry = archive.by_name(&inner).map_err(|err| format!("{}: {inner} in {asset}: {err}", e.name))?;
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|err| format!("{}: {inner}: {err}", e.name))?;
        files.push(ResolvedFile { rel: format!("{}/{name}", e.target), sha: hash::bytes(&data), content: Content::Bytes(data) });
    }
    Ok(Resolved {
        name: e.name.clone(),
        target: e.target.clone(),
        files,
        source: SourceLink::new(&format!("https://github.com/{repo}"), tag, Some(commit)),
        warnings: Vec::new(),
    })
}

fn resolve(layout: &Layout, e: &Entry) -> Result<Resolved, String> {
    match &e.source {
        Source::Local { repo, branch, checkout, build } => resolve_local(e, repo, branch, checkout, build),
        Source::GithubRelease { repo, tag, asset, subdir, sha256 } => {
            resolve_release(layout, e, repo, tag, asset, subdir.as_deref(), sha256.as_deref())
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppliedEntry {
    pub name: String,
    pub target: String,
    pub files: usize,
    pub written: usize,
    pub source: SourceLink,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverlayReport {
    pub manifest: String,
    pub change: Meta,
    pub entries: Vec<AppliedEntry>,
}

/// Applies every entry of the manifest at `manifest_path`, as one change.
pub fn apply(layout: &Layout, probe: &dyn ProcessProbe, manifest_path: &Path) -> Result<OverlayReport, String> {
    ensure_cs2_closed(probe)?;
    let manifest = Manifest::load(manifest_path)?;
    let resolved = manifest.entries.iter().map(|e| resolve(layout, e)).collect::<Result<Vec<_>, _>>()?;
    let (entries, change) = changes::run(layout, probe, "overlay", |cs| {
        let mut st = state::load(layout)?;
        let mut applied = Vec::new();
        for r in &resolved {
            let mut written = 0;
            let mut record = BTreeMap::new();
            for f in &r.files {
                let changed = match &f.content {
                    Content::File(p) => cs.put_file(&f.rel, p, &f.sha)?,
                    Content::Bytes(b) => cs.put_bytes(&f.rel, b)?,
                };
                written += usize::from(changed);
                record.insert(f.rel.clone(), f.sha.clone());
            }
            st.overlays.retain(|o| !o.name.eq_ignore_ascii_case(&r.name));
            st.overlays.push(OverlayRecord {
                name: r.name.clone(),
                target: r.target.clone(),
                files: record,
                source: r.source.clone(),
                applied_at: changes::now_utc().1,
            });
            applied.push(AppliedEntry {
                name: r.name.clone(),
                target: r.target.clone(),
                files: r.files.len(),
                written,
                source: r.source.clone(),
                warnings: r.warnings.clone(),
            });
        }
        state::save(layout, &st)?;
        Ok(applied)
    })?;
    Ok(OverlayReport { manifest: manifest_path.display().to_string(), change, entries })
}

/// Writes the example manifest to `path`, refusing to replace an existing one.
pub fn init_manifest(path: &Path) -> Result<(), String> {
    Manifest::parse(EXAMPLE)?;
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::write(path, EXAMPLE).map_err(|e| format!("{}: {e}", path.display()))
}
