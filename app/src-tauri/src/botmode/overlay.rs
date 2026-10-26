//! The overlay: the user's own plugin builds, copied over the official release.
//!
//! The set lives in a manifest file (`overlay.json` in the app's Bot Mode folder; a
//! copy of the user's set is `botmode/overlay.example.json` in this crate). Each
//! entry names a plugin folder under `addons\`, the files to copy into it, and where they
//! come from:
//! - `local`: a build folder inside a git checkout. The checkout must be on the named
//!   branch, have no uncommitted changes to tracked files, and have its commit on a remote
//!   branch, so the recorded source link points at the code that was built. An entry that
//!   pins `commit` instead requires the checkout to be at exactly that commit (a detached
//!   build worktree is fine) and the commit to be on `branch` at a remote.
//! - `github-release`: a zip attached to a GitHub release, verified like the official one.
//!
//! Every entry is resolved and verified before the first file is written.

use super::changes::{self, Meta};
use super::github;
use super::hash;
use super::install::UnpackBudget;
use super::paths::{self, Layout, Protection};
use super::process::{ensure_cs2_closed, OpLock, Phase, ProcessProbe};
use super::state::{self, OverlayRecord, SourceLink};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
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
        /// The full commit id the build must come from, when pinned.
        #[serde(default)]
        commit: Option<String>,
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
                Source::Local { repo, branch, commit, .. } => {
                    github::check_repo(repo)?;
                    if branch.trim().is_empty() {
                        return fail("names no branch".into());
                    }
                    if commit.as_ref().is_some_and(|c| c.len() != 40 || !c.bytes().all(|b| b.is_ascii_hexdigit())) {
                        return fail("commit must be a full 40-character commit id".into());
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

struct ResolvedFile {
    rel: String,
    sha: String,
    /// The built or unpacked file to copy.
    src: PathBuf,
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

fn resolve_local(e: &Entry, repo: &str, branch: &str, checkout: &str, build: &str, pinned: Option<&str>) -> Result<Resolved, String> {
    let checkout = paths::expand_env(checkout)?;
    let build_dir = {
        let b = paths::expand_env(build)?;
        if b.is_absolute() { b } else { checkout.join(b) }
    };
    let commit = git(&checkout, &["rev-parse", "HEAD"])?;
    match pinned {
        Some(want) if !commit.eq_ignore_ascii_case(want) => {
            return Err(format!("{}: {} is at commit {commit}, but the manifest pins {want}", e.name, checkout.display()));
        }
        Some(_) => {
            let remote = git(&checkout, &["branch", "-r", "--contains", "HEAD"])?;
            let suffix = format!("/{branch}");
            if !remote.lines().any(|l| l.trim().ends_with(&suffix) && !l.contains("->")) {
                return Err(format!("{}: commit {} is not on {branch} at any remote", e.name, &commit[..12.min(commit.len())]));
            }
        }
        None => {
            let on = git(&checkout, &["rev-parse", "--abbrev-ref", "HEAD"])?;
            if on != *branch {
                return Err(format!("{}: {} is on branch {on}, but the manifest names {branch}", e.name, checkout.display()));
            }
        }
    }
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
        files.push(ResolvedFile { rel: format!("{}/{f}", e.target), sha, src: path });
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
    let mut budget = UnpackBudget::for_zip(&zip_path)?;
    // Files are unpacked to a staging folder next to the zip, never held whole in memory.
    let staging = zip_path.with_extension("files");
    std::fs::create_dir_all(&staging).map_err(|err| format!("{}: {err}", staging.display()))?;
    let mut files = Vec::new();
    for name in &e.files {
        let inner = match subdir {
            Some(d) => format!("{}/{name}", paths::rel(d)?),
            None => name.clone(),
        };
        let entry = archive.by_name(&inner).map_err(|err| format!("{}: {inner} in {asset}: {err}", e.name))?;
        let declared = entry.size();
        let out_path = staging.join(name);
        let out = std::fs::File::create(&out_path).map_err(|err| format!("{}: {err}", out_path.display()))?;
        let (sha, _) = hash::copy(budget.read(&inner, declared, entry), out).map_err(|err| format!("{}: {inner}: {err}", e.name))?;
        files.push(ResolvedFile { rel: format!("{}/{name}", e.target), sha, src: out_path });
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
        Source::Local { repo, branch, checkout, build, commit } => resolve_local(e, repo, branch, checkout, build, commit.as_deref()),
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
    ensure_cs2_closed(probe, Phase::Operation)?;
    let lock = OpLock::acquire(layout)?;
    let manifest = Manifest::load(manifest_path)?;
    let resolved = manifest.entries.iter().map(|e| resolve(layout, e)).collect::<Result<Vec<_>, _>>()?;
    let (entries, change) = changes::run(layout, probe, &lock, "overlay", |cs| {
        let mut st = state::load(layout)?;
        let mut applied = Vec::new();
        for r in &resolved {
            let mut written = 0;
            let mut record = BTreeMap::new();
            for f in &r.files {
                let changed = cs.put_file(&f.rel, &f.src, &f.sha)?;
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

/// Writes the example manifest to `path`, which must be inside the app's Bot Mode folder.
/// Takes the operation lock, and creates the file new: the content goes to a synced temporary
/// file that is then renamed into place without replacing, which fails if the file exists.
pub fn init_manifest(layout: &Layout, path: &Path) -> Result<(), String> {
    Manifest::parse(EXAMPLE)?;
    let _lock = OpLock::acquire(layout)?;
    let data = layout.data.canonicalize().map_err(|e| format!("{}: {e}", layout.data.display()))?;
    let parent = path.parent().ok_or_else(|| format!("{}: no parent folder", path.display()))?;
    let name = path.file_name().ok_or_else(|| format!("{}: no file name", path.display()))?;
    let parent_canon = parent.canonicalize().map_err(|e| format!("{}: {e}", parent.display()))?;
    if !parent_canon.starts_with(&data) {
        return Err(format!("{}: the manifest must live inside the app folder {}", path.display(), data.display()));
    }
    let target = parent_canon.join(name);
    let tmp = parent_canon.join(format!("{}{}", name.to_string_lossy(), paths::TMP_SUFFIX));
    std::fs::File::create(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, EXAMPLE.as_bytes()).and_then(|_| f.sync_all()))
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    let moved = paths::rename_no_replace(&tmp, &target);
    if moved.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    moved.map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("{} already exists", target.display()),
        _ => format!("{}: {e}", target.display()),
    })?;
    paths::flush_dir(&parent_canon).map(|_| ())
}
