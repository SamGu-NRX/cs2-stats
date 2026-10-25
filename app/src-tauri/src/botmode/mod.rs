//! Bot Mode: installs ed0ard's CS2-Bot-Improver release into CS2, overlays the user's own
//! plugin builds, protects the user's own files, and starts CS2 with `-insecure`.
//!
//! This is a clean-room implementation from the mod's README, its docs and the files a
//! release zip contains. It shares no code with the mod's Panel, which is under PolyForm
//! Strict. The mod and the user's plugin forks are AGPL-3.0; Bot Mode installs their builds
//! unmodified and records a source link for each (`state.rs`).
//!
//! The Tauri commands are in `commands.rs`, and the same operations are on the command
//! line as `cs2-stats botmode ...` (`cli.rs`).

pub mod cfg;
pub mod changes;
pub mod cli;
pub mod commands;
pub mod components;
pub mod gameinfo;
pub mod github;
pub mod hash;
pub mod install;
pub mod launch;
pub mod overlay;
pub mod paths;
pub mod process;
pub mod settings;
pub mod state;
pub mod status;
pub mod steam;
pub mod vdf;

#[cfg(test)]
mod testutil;
#[cfg(test)]
mod tests;

use paths::Layout;
use std::path::PathBuf;

/// The game folder and app folder an operation works on, and the Steam install when found.
pub struct Ctx {
    pub layout: Layout,
    pub install: Option<steam::Cs2Install>,
}

impl Ctx {
    /// Finds CS2 through Steam, unless `game` names the `game\csgo` folder directly.
    pub fn new(game: Option<PathBuf>, data: Option<PathBuf>) -> Result<Ctx, String> {
        let data = match data {
            Some(d) => d,
            None => paths::default_data_dir()?,
        };
        let found = steam::steam_root().and_then(|s| steam::find_cs2(&s));
        let (csgo, install) = match game {
            Some(g) => {
                if !g.join("gameinfo.gi").is_file() {
                    return Err(format!("{}: not a CS2 game\\csgo folder (no gameinfo.gi)", g.display()));
                }
                (g, found.ok())
            }
            None => {
                let i = found?;
                (i.csgo.clone(), Some(i))
            }
        };
        Ok(Ctx { layout: Layout { csgo, data }, install })
    }

    pub fn steam(&self) -> Result<PathBuf, String> {
        match &self.install {
            Some(i) => Ok(i.steam.clone()),
            None => steam::steam_root(),
        }
    }

    /// CS2's launch options as stored in Steam. An unreadable `localconfig.vdf` is an error,
    /// so launch can refuse rather than miss a `-secure` there.
    pub fn steam_launch_options(&self) -> Result<Option<String>, String> {
        match &self.install {
            Some(i) => steam::launch_options(&i.steam, i.owner),
            None => Ok(None),
        }
    }
}
