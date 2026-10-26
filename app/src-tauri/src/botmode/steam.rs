//! Finding Steam, the CS2 install, and the launch options set for CS2 in Steam.

use super::vdf::{self, Node};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

pub const CS2_APP_ID: &str = "730";
/// CS2's folder under `steamapps\common`, from its app manifest.
const CS2_INSTALL_DIR: &str = "Counter-Strike Global Offensive";
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
    let mut libraries: Vec<(bool, PathBuf)> = Vec::new();
    for (_, lib) in folders.entries() {
        let Some(path) = lib.get("path").and_then(Node::str) else { continue };
        let path = PathBuf::from(path);
        if !path.is_absolute() || path.components().any(|c| !matches!(c, Component::Prefix(_) | Component::RootDir | Component::Normal(_))) {
            return Err(format!("{}: library path {} is not a plain absolute path", lf.display(), path.display()));
        }
        libraries.push((lib.path(&["apps", CS2_APP_ID]).is_some(), path));
    }
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
        if dir != CS2_INSTALL_DIR {
            return Err(format!("{}: installdir is {dir:?}, not {CS2_INSTALL_DIR:?}", manifest.display()));
        }
        let csgo = library.join("steamapps").join("common").join(dir).join("game").join("csgo");
        if !csgo.join("gameinfo.gi").is_file() {
            return Err(format!("{}: CS2 is listed here but {} has no gameinfo.gi", manifest.display(), csgo.display()));
        }
        check_game_folder(&csgo)?;
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

/// Checks that `csgo` is a CS2 `game\csgo` folder: it has `gameinfo.gi`, and with every link
/// resolved it ends in `steamapps\common\Counter-Strike Global Offensive\game\csgo`, so a
/// junction anywhere on the way cannot make it lead somewhere else. Returns the canonical path.
pub fn check_game_folder(csgo: &Path) -> Result<PathBuf, String> {
    if !csgo.join("gameinfo.gi").is_file() {
        return Err(format!("{}: not a CS2 game\\csgo folder (no gameinfo.gi)", csgo.display()));
    }
    let canon = csgo.canonicalize().map_err(|e| format!("{}: {e}", csgo.display()))?;
    let tail: Vec<String> = canon.components().rev().take(5).map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase()).collect();
    if tail != ["csgo", "game", &CS2_INSTALL_DIR.to_ascii_lowercase(), "common", "steamapps"] {
        return Err(format!(
            "{} resolves to {}, which is not a ...\\steamapps\\common\\{CS2_INSTALL_DIR}\\game\\csgo folder",
            csgo.display(),
            canon.display()
        ));
    }
    Ok(canon)
}

/// Where Steam keeps CS2's launch options for the account that owns the install:
/// `userdata\<account>\config\localconfig.vdf`. Steam adds these options to every start.
#[derive(Debug, Clone)]
pub struct SteamConfig {
    pub steam: PathBuf,
    pub localconfig: PathBuf,
}

impl SteamConfig {
    /// Needs the install's owner (`LastOwner` in the app manifest); without it the account,
    /// and so the options Steam will add, are unknown.
    pub fn for_install(i: &Cs2Install) -> Result<SteamConfig, String> {
        let owner = i.owner.filter(|o| *o > STEAMID64_BASE).ok_or_else(|| {
            "CS2's app manifest names no valid owner (LastOwner), so the Steam account whose launch options apply is unknown. Start CS2 once from Steam so Steam records its owner in appmanifest_730.acf, or repair LastOwner there".to_string()
        })?;
        let localconfig = i.steam.join("userdata").join((owner - STEAMID64_BASE).to_string()).join("config").join("localconfig.vdf");
        Ok(SteamConfig { steam: i.steam.clone(), localconfig })
    }

    /// CS2's launch options from Steam; empty when the file sets none. A missing or unreadable
    /// file is an error, never "no options".
    /// Every key on the way to the options must appear once and be a block; a missing block
    /// means Steam has no options stored for CS2.
    pub fn read_options(&self) -> Result<String, String> {
        let path = self.localconfig.display();
        if !self.localconfig.exists() {
            return Err(format!("{path} does not exist. Start Steam and sign in once so it writes this file"));
        }
        let root = read_vdf(&self.localconfig)?;
        let mut node = match root.get_unique("UserLocalConfigStore").map_err(|e| format!("{path}: {e}"))? {
            Some(n @ Node::Map(_)) => n,
            _ => return Err(format!("{path}: no UserLocalConfigStore block; not a Steam localconfig.vdf")),
        };
        for key in ["Software", "Valve", "Steam", "apps", CS2_APP_ID] {
            match node.get_unique(key).map_err(|e| format!("{path}: {e}"))? {
                Some(n @ Node::Map(_)) => node = n,
                Some(Node::Str(_)) => return Err(format!("{path}: \"{key}\" is a value where a block belongs")),
                None => return Ok(String::new()),
            }
        }
        match node.get_unique("LaunchOptions").map_err(|e| format!("{path}: {e}"))? {
            Some(Node::Str(s)) => Ok(s.clone()),
            Some(Node::Map(_)) => Err(format!("{path}: LaunchOptions is a block, not a value")),
            None => Ok(String::new()),
        }
    }
}

/// The launch options, for the status report only: anything unreadable shows as none.
pub fn launch_options(install: &Cs2Install) -> Option<String> {
    SteamConfig::for_install(install).and_then(|c| c.read_options()).ok()
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
            "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"installdir\"\t\t\"Counter-Strike Global Offensive\"\n\t\"buildid\"\t\t\"26144732\"\n\t\"LastOwner\"\t\t\"76561197961265729\"\n}\n",
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
    fn library_paths_and_install_folders_that_could_lead_elsewhere_are_refused() {
        let s = Scratch::new("steam-vdf");
        let (steam, csgo) = fake_steam(&s);
        let lf = steam.join("steamapps/libraryfolders.vdf");
        let original = fs::read_to_string(&lf).unwrap();
        let esc = |p: &Path| p.display().to_string().replace('\\', "\\\\");
        let lib2 = s.0.join("Games Lib");
        for bad in [s.0.join("x").join("..").join("Games Lib"), PathBuf::from("Games Lib")] {
            fs::write(&lf, original.replace(&esc(&lib2), &esc(&bad))).unwrap();
            let err = find_cs2(&steam).unwrap_err();
            assert!(err.contains("not a plain absolute path"), "{bad:?}: {err}");
        }
        fs::write(&lf, &original).unwrap();

        let acf = lib2.join("steamapps/appmanifest_730.acf");
        let manifest = fs::read_to_string(&acf).unwrap();
        fs::write(&acf, manifest.replace("Counter-Strike Global Offensive", "..\\..\\Windows")).unwrap();
        assert!(find_cs2(&steam).unwrap_err().contains("installdir is"));
        fs::write(&acf, &manifest).unwrap();

        // The install folder is a junction to a folder that is not CS2's.
        #[cfg(windows)]
        {
            let elsewhere = s.0.join("elsewhere");
            write(&elsewhere.join("game/csgo/gameinfo.gi"), "\"GameInfo\" {}");
            let cs2 = csgo.parent().unwrap().parent().unwrap().to_path_buf();
            fs::remove_dir_all(&cs2).unwrap();
            crate::botmode::testutil::junction(&cs2, &elsewhere);
            let err = find_cs2(&steam).unwrap_err();
            assert!(err.contains("which is not a"), "{err}");
        }
    }

    #[test]
    fn reads_the_owners_cs2_launch_options_and_never_guesses_them() {
        let s = Scratch::new("steam-opts");
        let (steam, _) = fake_steam(&s);
        let install = find_cs2(&steam).unwrap();
        let config = SteamConfig::for_install(&install).unwrap();
        assert_eq!(config.localconfig, steam.join("userdata/1000001/config/localconfig.vdf"));

        // Missing, unreadable and not-a-localconfig files are errors, never "no options".
        assert!(config.read_options().unwrap_err().contains("Start Steam and sign in once"), "missing file says how to fix it");
        write(&config.localconfig, "\"UserLocalConfigStore\"\n{\n\"Software\"\n");
        assert!(config.read_options().is_err(), "unbalanced file");
        write(&config.localconfig, "\"SomethingElse\"\n{\n}\n");
        assert!(config.read_options().is_err(), "another file");
        fs::remove_file(&config.localconfig).unwrap();
        fs::create_dir_all(&config.localconfig).unwrap();
        assert!(config.read_options().is_err(), "a folder in its place");
        fs::remove_dir(&config.localconfig).unwrap();

        write(&config.localconfig, &crate::botmode::testutil::localconfig("-condebug +exec autoexec -insecure"));
        assert_eq!(config.read_options().unwrap(), "-condebug +exec autoexec -insecure");

        // Strict on the way to the options: duplicate keys and values where blocks belong.
        let good = crate::botmode::testutil::localconfig("-insecure");
        for (why, from, to) in [
            ("duplicate LaunchOptions", "\"LaunchOptions\"\t\t\"-insecure\"", "\"LaunchOptions\" \"-insecure\" \"LaunchOptions\" \"-secure\""),
            ("duplicate app block", "\"730\"\n", "\"730\" { }\n\"730\"\n"),
            ("apps is a value", "\"apps\"\n", "\"apps\" \"x\"\n\"other\"\n"),
        ] {
            assert!(good.contains(from), "{why}: the sample must contain the text to change");
            write(&config.localconfig, &good.replace(from, to));
            assert!(config.read_options().is_err(), "{why}");
        }
        write(&config.localconfig, "\"UserLocalConfigStore\" \"x\"\n");
        assert!(config.read_options().is_err(), "UserLocalConfigStore is a value");

        // Without a known owner the account, and so the options, are unknown.
        for owner in [None, Some(0), Some(42)] {
            let err = SteamConfig::for_install(&Cs2Install { owner, ..install.clone() }).unwrap_err();
            assert!(err.contains("no valid owner") && err.contains("Start CS2 once from Steam"), "{owner:?}: {err}");
        }
    }
}
