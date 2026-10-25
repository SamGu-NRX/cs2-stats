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

/// Which game folder to use.
pub enum Game {
    /// Found through Steam.
    Steam,
    /// Named directly. It must pass the same identity check as a folder found through Steam.
    Folder(PathBuf),
    /// Named directly, without the `...\steamapps\common\Counter-Strike Global Offensive`
    /// identity check, to run the CLI against a scratch copy. Debug builds only; release builds
    /// and the Tauri commands cannot construct it.
    #[cfg(debug_assertions)]
    UncheckedForTesting(PathBuf),
}

impl Ctx {
    pub fn new(game: Game, data: Option<PathBuf>) -> Result<Ctx, String> {
        let data = match data {
            Some(d) => d,
            None => paths::default_data_dir()?,
        };
        // A named folder is checked before Steam is searched.
        let found = || steam::steam_root().and_then(|s| steam::find_cs2(&s));
        let (csgo, install) = match game {
            Game::Steam => {
                let i = found()?;
                (i.csgo.clone(), Some(i))
            }
            Game::Folder(g) => {
                steam::check_game_folder(&g)?;
                (g, found().ok())
            }
            #[cfg(debug_assertions)]
            Game::UncheckedForTesting(g) => {
                if !g.join("gameinfo.gi").is_file() {
                    return Err(format!("{}: no gameinfo.gi", g.display()));
                }
                (g, found().ok())
            }
        };
        Ok(Ctx { layout: Layout { csgo, data }, install })
    }

    /// Steam's folder and the file holding CS2's launch options. Launch needs both; with no
    /// Steam install found, or no known owner, it refuses.
    pub fn steam_config(&self) -> Result<steam::SteamConfig, String> {
        let i = self.install.as_ref().ok_or(
            "CS2 was not found through Steam, so the launch options Steam adds cannot be checked; Bot Mode will not launch",
        )?;
        steam::SteamConfig::for_install(i)
    }

    /// For the status report only.
    pub fn steam_launch_options(&self) -> Option<String> {
        self.install.as_ref().and_then(steam::launch_options)
    }
}
