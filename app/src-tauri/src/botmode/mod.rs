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
pub mod monitor;
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
    /// Why Steam discovery failed, when it did, for the launch refusal.
    pub discovery_error: Option<String>,
}

/// Which game folder to use.
pub enum Game {
    /// Found through Steam.
    Steam,
    /// Named directly. It must be the same folder as the CS2 install Steam reports (a machine
    /// can have several Steam libraries, and only that one is the game Steam will start).
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
        let found = steam::steam_root().and_then(|s| steam::find_cs2(&s)).map_err(|e| {
            format!(
                "{e}. Bot Mode finds CS2 through Steam: check that Steam and CS2 are installed, and repair or reinstall CS2 in Steam if its appmanifest_730.acf is damaged"
            )
        });
        let (csgo, install, discovery_error) = match game {
            Game::Steam => {
                let i = found?;
                (i.csgo.clone(), Some(i), None)
            }
            Game::Folder(g) => {
                let i = same_install(&g, found)?;
                (g, Some(i), None)
            }
            #[cfg(debug_assertions)]
            Game::UncheckedForTesting(g) => {
                if !g.join("gameinfo.gi").is_file() {
                    return Err(format!("{}: no gameinfo.gi", g.display()));
                }
                match found {
                    Ok(i) => (g, Some(i), None),
                    Err(e) => (g, None, Some(e)),
                }
            }
        };
        Ok(Ctx { layout: Layout { csgo, data }, install, discovery_error })
    }

    /// Steam's folder and the file holding CS2's launch options, both from the same app
    /// manifest as the game folder. Launch needs them; without them it refuses.
    pub fn steam_config(&self) -> Result<steam::SteamConfig, String> {
        let i = self.install.as_ref().ok_or_else(|| {
            format!(
                "CS2 was not found through Steam ({}), so the launch options Steam adds cannot be checked; Bot Mode will not launch",
                self.discovery_error.as_deref().unwrap_or("no Steam install")
            )
        })?;
        steam::SteamConfig::for_install(i)
    }

    /// For the status report only.
    pub fn steam_launch_options(&self) -> Option<String> {
        self.install.as_ref().and_then(steam::launch_options)
    }
}

/// Checks that a folder named with `--game` is the CS2 install Steam reports, and returns
/// that install. Both paths are compared with every link resolved.
pub fn same_install(named: &std::path::Path, found: Result<steam::Cs2Install, String>) -> Result<steam::Cs2Install, String> {
    let named_canon = steam::check_game_folder(named)?;
    let i = found.map_err(|e| format!("--game {} cannot be checked against Steam: {e}; or omit --game", named.display()))?;
    let steam_canon = i.csgo.canonicalize().map_err(|e| format!("{}: {e}", i.csgo.display()))?;
    if named_canon != steam_canon {
        return Err(format!(
            "--game names {}, but Steam reports CS2 at {}; Bot Mode only works on the install Steam starts. Omit --game, or point it at that folder.",
            named_canon.display(),
            steam_canon.display()
        ));
    }
    Ok(i)
}
