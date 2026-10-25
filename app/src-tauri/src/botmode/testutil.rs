//! Temporary folders, fake game trees and fake release zips for the Bot Mode tests.

use super::gameinfo::{self, ONLINE_SAMPLE};
use super::paths::{join_rel, Layout};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A fresh folder under the system temp folder, removed when dropped.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        static N: AtomicUsize = AtomicUsize::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("cs2stats-botmode-{tag}-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn write(path: &Path, data: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, data).unwrap();
}

/// The user's own files in the fake game folder.
pub const USER_SERVER_CFG: &str = "// mine\r\nbr_dropped_knife_skins 1\r\nbr_player_music_kit 33\r\n";
pub const USER_AUTOEXEC: &str = "bind mouse4 +lookatweapon\r\n";
pub const USER_SKELETON: &str = "addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c";

/// A game folder as Steam leaves it plus the user's own files: Valve's `gameinfo.gi`
/// (Bot Mode off), a hand-written server cfg, an autoexec and a skeleton override.
pub fn fake_game(s: &Scratch) -> Layout {
    let layout = Layout { csgo: s.0.join("game").join("csgo"), data: s.0.join("data") };
    write(&layout.target("gameinfo.gi"), ONLINE_SAMPLE.as_bytes());
    write(&layout.target("cfg/gamemode_competitive_server.cfg"), USER_SERVER_CFG.as_bytes());
    write(&layout.target("cfg/autoexec.cfg"), USER_AUTOEXEC.as_bytes());
    write(&layout.target(USER_SKELETON), b"user skeleton");
    write(&layout.target("cfg/server.cfg"), b"// valve\r\n");
    layout
}

/// The release's `my_bot_normal_config.cfg`, before its version comment.
pub const RELEASE_BOT_CFG: &str = "mp_c4timer 40\r\nbot_difficulty 5\r\nexec bot_buy.cfg\r\nbind \\ \"subclass_create 500;subclass_create 503\"\r\n";

/// The files of a fake release, shaped like the v1.4.7 Windows zip: the Panel at the root,
/// Metamod and CounterStrikeSharp, a plugin, mod cfgs, bot profiles, both gameinfo copies,
/// and a few files that would hit the user's protected files if copied blindly.
pub fn release_files(version: &str) -> BTreeMap<String, Vec<u8>> {
    let with_bots = gameinfo::enable(ONLINE_SAMPLE).unwrap();
    let mut f: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut put = |k: &str, v: &[u8]| {
        f.insert(k.to_string(), v.to_vec());
    };
    put("Panel v1.4.7.exe", b"MZ panel");
    put("gameinfo.gi", with_bots.as_bytes());
    put("backup/Online/gameinfo.gi", ONLINE_SAMPLE.as_bytes());
    put("backup/WithBots/gameinfo.gi", with_bots.as_bytes());
    put("addons/metamod.vdf", b"\"Plugin\" { \"file\" \"addons/metamod/bin/server\" }");
    put("addons/metamod/bin/server.dll", format!("metamod {version}").as_bytes());
    put("addons/counterstrikesharp/bin/win64/counterstrikesharp.dll", format!("css {version}").as_bytes());
    put("addons/counterstrikesharp/plugins/BotState/BotState.dll", format!("official botstate {version}").as_bytes());
    put("cfg/my_bot_normal_config.cfg", format!("{RELEASE_BOT_CFG}// {version}\r\n").as_bytes());
    put("cfg/autoexec.cfg", b"// the release's autoexec\r\n");
    put("cfg/gamemode_competitive_server.cfg", b"br_player_music_kit 0\r\nbr_dropped_knife_premium 0\r\n");
    put(USER_SKELETON, b"release skeleton");
    put("overrides/botprofile.vpk", format!("medium {version}").as_bytes());
    put("overrides/Low/botprofile.vpk", format!("low {version}").as_bytes());
    put("overrides/Medium/botprofile.vpk", format!("medium {version}").as_bytes());
    put("overrides/High/botprofile.vpk", format!("high {version}").as_bytes());
    f
}

/// Writes `files` as a zip (stored, with directory entries like the real release).
pub fn write_zip(path: &Path, files: &BTreeMap<String, Vec<u8>>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    z.add_directory("addons/", opts).unwrap();
    for (name, data) in files {
        z.start_file(name.as_str(), opts).unwrap();
        z.write_all(data).unwrap();
    }
    z.finish().unwrap();
}

/// Every file under `root` with its content, for before/after comparisons.
pub fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(items) = fs::read_dir(dir) else { return };
        for item in items.flatten() {
            let p = item.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(rel, fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/// A directory junction at `link` pointing to `target`, as `mklink /J` makes.
#[cfg(windows)]
pub fn junction(link: &Path, target: &Path) {
    let out = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
    assert!(out.status.success(), "mklink: {}", String::from_utf8_lossy(&out.stderr));
}

pub fn read(layout: &Layout, rel: &str) -> String {
    fs::read_to_string(join_rel(&layout.csgo, rel)).unwrap()
}
