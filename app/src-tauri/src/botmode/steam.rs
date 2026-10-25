//! Finding Steam, the CS2 install, and the launch options set for CS2 in Steam.

use super::vdf::{self, Node};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const CS2_APP_ID: &str = "730";
/// Offset between a SteamID64 and the 32-bit account id used for `userdata\<id>` folders.
const STEAMID64_BASE: u64 = 76_561_197_960_265_728;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cs2Install {
    pub steam: PathBuf,
    pub library: PathBuf,
    /// `...\game\csgo`
    pub csgo: PathBuf,
    pub build_id: Option<String>,
    /// SteamID64 of the account that last owned the install.
    pub owner: Option<u64>,
}

/// Steam's folder: `HKCU\Software\Valve\Steam\SteamPath`, then the machine-wide install path.
pub fn steam_root() -> Result<PathBuf, String> {
    let found = reg::read_string(reg::Hive::CurrentUser, r"Software\Valve\Steam", "SteamPath")
        .or_else(|| reg::read_string(reg::Hive::LocalMachine, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"))
        // SteamPath is stored with forward slashes ("c:/program files (x86)/steam").
        .map(|s| PathBuf::from(if cfg!(windows) { s.replace('/', "\\") } else { s }))
        .filter(|p| p.join("steam.exe").is_file() || p.join("steamapps").is_dir());
    found.ok_or_else(|| "Steam is not installed (no SteamPath in the registry)".into())
}

fn read_vdf(path: &Path) -> Result<Node, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    vdf::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Finds CS2 through `steamapps\libraryfolders.vdf`. A library that lists app 730 is tried
/// first; any library holding `appmanifest_730.acf` is accepted.
pub fn find_cs2(steam: &Path) -> Result<Cs2Install, String> {
    let lf = steam.join("steamapps").join("libraryfolders.vdf");
    let root = read_vdf(&lf)?;
    let folders = root.get("libraryfolders").ok_or_else(|| format!("{}: no libraryfolders key", lf.display()))?;
    let mut libraries: Vec<(bool, PathBuf)> = folders
        .entries()
        .iter()
        .filter_map(|(_, lib)| {
            let path = lib.get("path")?.str()?;
            let lists = lib.path(&["apps", CS2_APP_ID]).is_some();
            Some((lists, PathBuf::from(path)))
        })
        .collect();
    if libraries.is_empty() {
        libraries.push((false, steam.to_path_buf()));
    }
    libraries.sort_by_key(|(lists, _)| !*lists);
    for (_, library) in libraries {
        let manifest = library.join("steamapps").join(format!("appmanifest_{CS2_APP_ID}.acf"));
        if !manifest.is_file() {
            continue;
        }
        let acf = read_vdf(&manifest)?;
        let state = acf.get("AppState").ok_or_else(|| format!("{}: no AppState", manifest.display()))?;
        let dir = state.get("installdir").and_then(Node::str).ok_or_else(|| format!("{}: no installdir", manifest.display()))?;
        let csgo = library.join("steamapps").join("common").join(dir).join("game").join("csgo");
        if !csgo.join("gameinfo.gi").is_file() {
            return Err(format!("{}: CS2 is listed here but {} has no gameinfo.gi", manifest.display(), csgo.display()));
        }
        return Ok(Cs2Install {
            steam: steam.to_path_buf(),
            library,
            csgo,
            build_id: state.get("buildid").and_then(Node::str).map(str::to_string),
            owner: state.get("LastOwner").and_then(Node::str).and_then(|s| s.parse().ok()),
        });
    }
    Err(format!("CS2 is not installed in any Steam library listed in {}", lf.display()))
}

/// The launch options set for CS2 in Steam (Properties > General), from the owner's
/// `userdata\<account>\config\localconfig.vdf`. Steam adds these itself when it starts the
/// game, so Bot Mode only reads them, to report them.
pub fn launch_options(steam: &Path, owner: Option<u64>) -> Result<Option<String>, String> {
    let Some(owner) = owner.filter(|o| *o > STEAMID64_BASE) else { return Ok(None) };
    let path = steam
        .join("userdata")
        .join((owner - STEAMID64_BASE).to_string())
        .join("config")
        .join("localconfig.vdf");
    if !path.is_file() {
        return Ok(None);
    }
    let root = read_vdf(&path)?;
    Ok(root
        .path(&["UserLocalConfigStore", "Software", "Valve", "Steam", "apps", CS2_APP_ID, "LaunchOptions"])
        .and_then(Node::str)
        .map(str::to_string))
}

#[cfg(windows)]
mod reg {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    pub enum Hive {
        CurrentUser,
        LocalMachine,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read_string(hive: Hive, key: &str, value: &str) -> Option<String> {
        let root: HKEY = match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        };
        let (key, value) = (wide(key), wide(value));
        let mut buf = vec![0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: the buffers outlive the call and `size` holds the buffer's size in bytes.
        let rc = unsafe {
            RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
        };
        if rc != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(not(windows))]
mod reg {
    pub enum Hive {
        CurrentUser,
        LocalMachine,
    }
    pub fn read_string(_hive: Hive, _key: &str, _value: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::botmode::testutil::Scratch;
    use std::fs;

    fn write(p: &Path, text: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    /// Two libraries; CS2 lives in the second, which lists app 730.
    fn fake_steam(s: &Scratch) -> (PathBuf, PathBuf) {
        let steam = s.0.join("Steam");
        let lib2 = s.0.join("Games Lib");
        let lf = format!(
            "\"libraryfolders\"\n{{\n\t\"0\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t\t\"apps\"\n\t\t{{\n\t\t\t\"228980\"\t\t\"1\"\n\t\t}}\n\t}}\n\t\"1\"\n\t{{\n\t\t\"path\"\t\t\"{}\"\n\t\t\"apps\"\n\t\t{{\n\t\t\t\"730\"\t\t\"1\"\n\t\t}}\n\t}}\n}}\n",
            steam.display().to_string().replace('\\', "\\\\"),
            lib2.display().to_string().replace('\\', "\\\\")
        );
        write(&steam.join("steamapps/libraryfolders.vdf"), &lf);
        write(
            &lib2.join("steamapps/appmanifest_730.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"installdir\"\t\t\"Counter-Strike Global Offensive\"\n\t\"buildid\"\t\t\"26144732\"\n\t\"LastOwner\"\t\t\"76561199138360625\"\n}\n",
        );
        let csgo = lib2.join("steamapps/common/Counter-Strike Global Offensive/game/csgo");
        write(&csgo.join("gameinfo.gi"), "\"GameInfo\" {}");
        (steam, csgo)
    }

    #[test]
    fn finds_cs2_in_the_library_that_lists_it() {
        let s = Scratch::new("steam-find");
        let (steam, csgo) = fake_steam(&s);
        let found = find_cs2(&steam).unwrap();
        assert_eq!(found.csgo, csgo);
        assert_eq!(found.build_id.as_deref(), Some("26144732"));
        assert_eq!(found.owner, Some(76_561_199_138_360_625));
    }

    #[test]
    fn a_listed_install_without_game_files_is_reported() {
        let s = Scratch::new("steam-missing");
        let (steam, csgo) = fake_steam(&s);
        fs::remove_file(csgo.join("gameinfo.gi")).unwrap();
        let err = find_cs2(&steam).unwrap_err();
        assert!(err.contains("no gameinfo.gi"), "{err}");
    }

    #[test]
    fn reads_the_owners_cs2_launch_options() {
        let s = Scratch::new("steam-opts");
        let (steam, _) = fake_steam(&s);
        write(
            &steam.join("userdata/1178094897/config/localconfig.vdf"),
            "\"UserLocalConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Valve\"\n\t\t{\n\t\t\t\"Steam\"\n\t\t\t{\n\t\t\t\t\"apps\"\n\t\t\t\t{\n\t\t\t\t\t\"730\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"LaunchOptions\"\t\t\"-condebug +exec autoexec -insecure\"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n",
        );
        let opts = launch_options(&steam, Some(76_561_199_138_360_625)).unwrap();
        assert_eq!(opts.as_deref(), Some("-condebug +exec autoexec -insecure"));
    }
}
