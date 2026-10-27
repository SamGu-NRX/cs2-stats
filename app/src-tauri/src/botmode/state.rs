//! What Bot Mode has installed: the official release and each overlay, with the hash of
//! every file it wrote and the source link for every AGPL component. Stored in
//! `state.json` in the app's Bot Mode folder, and restored by rollback.

use super::changes::write_atomic;
use super::paths::Layout;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub official: Option<Official>,
    #[serde(default)]
    pub overlays: Vec<OverlayRecord>,
    /// The keys of the marked `unbind` lines this app wrote into the server cfg
    /// (`settings::KnifeBind`). A marked line for any other key is the user's own.
    #[serde(default)]
    pub knife_unbinds: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Official {
    pub tag: String,
    pub asset: String,
    /// SHA-256 of the release zip.
    pub sha256: String,
    pub source: SourceLink,
    pub installed_at: String,
    /// Every file copied from the zip, by game path.
    pub files: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRecord {
    pub name: String,
    pub target: String,
    pub files: BTreeMap<String, String>,
    pub source: SourceLink,
    pub applied_at: String,
}

/// Where the source of an installed AGPL component is published.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLink {
    /// "https://github.com/owner/repo"
    pub repo: String,
    /// Branch or tag the build came from.
    pub reference: String,
    /// Full commit id, when known.
    pub commit: Option<String>,
    /// A link to the source at that commit, or to the tag when the commit is unknown.
    pub url: String,
}

impl SourceLink {
    pub fn new(repo_url: &str, reference: &str, commit: Option<String>) -> SourceLink {
        let at = commit.as_deref().unwrap_or(reference);
        SourceLink { repo: repo_url.into(), reference: reference.into(), url: format!("{repo_url}/tree/{at}"), commit }
    }
}

pub fn load(layout: &Layout) -> Result<State, String> {
    let path = layout.state_file();
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn save(layout: &Layout, state: &State) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&layout.state_file(), text.as_bytes())
}
