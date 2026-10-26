//! GitHub release lookups and verified downloads.
//!
//! An asset is accepted only when its size and SHA-256 match what the GitHub API publishes
//! for it (the `digest` field), or a hash the caller supplies. An asset with neither is
//! refused rather than installed unchecked.

use super::hash;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    /// "sha256:<hex>" when GitHub has computed it.
    pub digest: Option<String>,
    pub browser_download_url: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Release {
    pub tag_name: String,
    pub html_url: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    pub assets: Vec<Asset>,
}

impl Asset {
    /// The expected SHA-256, from GitHub's digest or `override_sha`.
    pub fn sha256(&self, override_sha: Option<&str>) -> Result<String, String> {
        if let Some(s) = override_sha {
            return valid_sha(s);
        }
        match self.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
            Some(s) => valid_sha(s),
            None => Err(format!(
                "{}: GitHub publishes no SHA-256 for this asset, so it cannot be verified. Pass the expected hash with --sha256.",
                self.name
            )),
        }
    }
}

fn valid_sha(s: &str) -> Result<String, String> {
    let s = s.trim().to_ascii_lowercase();
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(s)
    } else {
        Err(format!("{s}: not a SHA-256 hex digest"))
    }
}

/// Repository names and tags become folder names, so only plain characters are allowed.
pub fn check_name(kind: &str, s: &str) -> Result<(), String> {
    let ok = !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if ok {
        Ok(())
    } else {
        Err(format!("{s}: not a valid {kind}"))
    }
}

/// "owner/name", each part checked.
pub fn check_repo(repo: &str) -> Result<(), String> {
    let mut parts = repo.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(o), Some(n), None) => check_name("repository owner", o).and(check_name("repository name", n)),
        _ => Err(format!("{repo}: expected owner/name")),
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(concat!("cs2-stats/", env!("CARGO_PKG_VERSION"), " botmode"))
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .build()
        .into()
}

fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    let mut resp = agent()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|e| format!("{url}: {e}"))?;
    let text = resp.body_mut().read_to_string().map_err(|e| format!("{url}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{url}: unexpected response: {e}"))
}

pub fn release(repo: &str, tag: &str) -> Result<Release, String> {
    check_repo(repo)?;
    check_name("tag", tag)?;
    get_json(&format!("https://api.github.com/repos/{repo}/releases/tags/{tag}"))
}

pub fn releases(repo: &str) -> Result<Vec<Release>, String> {
    check_repo(repo)?;
    get_json(&format!("https://api.github.com/repos/{repo}/releases?per_page=30"))
}

/// The commit a tag points at.
pub fn tag_commit(repo: &str, tag: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Commit {
        sha: String,
    }
    check_repo(repo)?;
    check_name("tag", tag)?;
    let c: Commit = get_json(&format!("https://api.github.com/repos/{repo}/commits/{tag}"))?;
    valid_sha1(&c.sha)
}

fn valid_sha1(s: &str) -> Result<String, String> {
    if s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(s.to_ascii_lowercase())
    } else {
        Err(format!("{s}: not a commit id"))
    }
}

/// Downloads `asset` to `dest` unless a verified copy is already there. Writes to
/// `dest.part` first and renames only after the size and hash check out.
pub fn download_verified(asset: &Asset, sha256: &str, dest: &Path) -> Result<(), String> {
    if dest.is_file() && hash::file(dest)? == sha256 {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let part = dest.with_extension("part");
    let url = &asset.browser_download_url;
    let resp = agent().get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let mut out = fs::File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
    let reader = resp.into_body().into_with_config().limit(asset.size + 1).reader();
    let (got, size) = hash::copy(reader, &mut out).map_err(|e| format!("{url}: {e}"))?;
    out.flush().and_then(|_| out.sync_all()).map_err(|e| format!("{}: {e}", part.display()))?;
    drop(out);
    if size != asset.size || got != sha256 {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "{}: download failed verification ({size} bytes, SHA-256 {got}; expected {} bytes, {sha256})",
            asset.name, asset.size
        ));
    }
    fs::rename(&part, dest).map_err(|e| format!("{}: {e}", dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_asset_without_a_published_digest_is_refused() {
        let a = Asset { name: "CS2BotImprover.zip".into(), size: 1, digest: None, browser_download_url: String::new() };
        assert!(a.sha256(None).unwrap_err().contains("cannot be verified"));
        let with = Asset { digest: Some(format!("sha256:{}", "AB".repeat(32))), ..a };
        assert_eq!(with.sha256(None).unwrap(), "ab".repeat(32));
    }

    #[test]
    fn tags_and_repos_that_could_name_other_folders_are_refused() {
        assert!(check_name("tag", "v1.4.7").is_ok());
        for bad in ["..", "v1/../../x", "a b", ""] {
            assert!(check_name("tag", bad).is_err(), "{bad}");
        }
        assert!(check_repo("ed0ard/CS2-Bot-Improver").is_ok());
        assert!(check_repo("ed0ard/CS2-Bot-Improver/extra").is_err());
    }
}
