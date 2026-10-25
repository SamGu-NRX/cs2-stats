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

/// The text of a Steam `localconfig.vdf` whose CS2 entry has `options` as its launch options.
pub fn localconfig(options: &str) -> String {
    format!(
        "\"UserLocalConfigStore\"\n{{\n\t\"Software\"\n\t{{\n\t\t\"Valve\"\n\t\t{{\n\t\t\t\"Steam\"\n\t\t\t{{\n\t\t\t\t\"apps\"\n\t\t\t\t{{\n\t\t\t\t\t\"730\"\n\t\t\t\t\t{{\n\t\t\t\t\t\t\"LaunchOptions\"\t\t\"{options}\"\n\t\t\t\t\t}}\n\t\t\t\t}}\n\t\t\t}}\n\t\t}}\n\t}}\n}}\n"
    )
}

/// A Steam folder with `steam.exe` and the owner's `localconfig.vdf`, which holds `options`
/// for CS2 unless `options` is `None`, in which case the file is not created.
pub fn fake_steam_config(s: &Scratch, options: Option<&str>) -> super::steam::SteamConfig {
    let steam = s.0.join("Steam");
    write(&steam.join("steam.exe"), b"");
    let localconfig_path = steam.join("userdata").join("1000001").join("config").join("localconfig.vdf");
    if let Some(o) = options {
        write(&localconfig_path, localconfig(o).as_bytes());
    }
    super::steam::SteamConfig { steam, localconfig: localconfig_path }
}

/// The game executable the fake system's processes run from by default.
pub const IMAGE: &str = r"C:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe";
/// A command line Bot Mode accepts.
pub const SAFE_LINE: &str = r#""C:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe" -insecure -novid"#;
const UNREADABLE_IMAGE: &str = "<unreadable for comparison>";

struct FakeProc {
    created: u64,
    image: String,
    line: Option<String>,
    broken: Option<&'static str>,
    failing_ends: u32,
    end_attempts: u32,
    ended: bool,
}

#[derive(Clone)]
struct ProcHandle(std::rc::Rc<std::cell::RefCell<FakeProc>>);

impl super::monitor::Cs2Process for ProcHandle {
    fn created(&self) -> Result<u64, String> {
        let p = self.0.borrow();
        if p.broken == Some("created") {
            return Err("access denied".into());
        }
        Ok(p.created)
    }
    fn image(&self) -> Result<PathBuf, String> {
        let p = self.0.borrow();
        match p.broken {
            Some("image") => Err("access denied".into()),
            Some("same_file") => Ok(PathBuf::from(UNREADABLE_IMAGE)),
            _ => Ok(PathBuf::from(&p.image)),
        }
    }
    fn command_line(&self) -> Result<String, String> {
        self.0.borrow().line.clone().ok_or_else(|| "access denied".into())
    }
    fn terminate(&self) -> Result<(), String> {
        let mut p = self.0.borrow_mut();
        p.end_attempts += 1;
        if p.failing_ends > 0 {
            p.failing_ends -= 1;
            return Err("access denied".into());
        }
        p.ended = true;
        Ok(())
    }
}

/// A process list scripted per poll (the last entry repeats), processes by id, and a clock
/// that moves only when the code under test sleeps.
pub struct FakeSystem {
    lists: std::cell::RefCell<std::collections::VecDeque<Result<Vec<(u32, u64)>, String>>>,
    procs: std::cell::RefCell<std::collections::HashMap<u32, ProcHandle>>,
    clock: std::cell::Cell<std::time::Duration>,
    sleeps: std::cell::RefCell<Vec<std::time::Duration>>,
    polls: std::cell::Cell<usize>,
    /// Polls on which listing panics, for the panic boundary.
    pub panic_on_polls: std::cell::RefCell<Vec<usize>>,
    pub alive: std::cell::RefCell<std::collections::HashSet<(u32, u64)>>,
    /// Called whenever the code under test reads the time, to observe what was true then.
    pub on_file_time: std::cell::RefCell<Option<Box<dyn Fn()>>>,
}

impl FakeSystem {
    pub fn new() -> FakeSystem {
        FakeSystem {
            lists: Default::default(),
            procs: Default::default(),
            clock: Default::default(),
            sleeps: Default::default(),
            polls: Default::default(),
            panic_on_polls: Default::default(),
            alive: Default::default(),
            on_file_time: Default::default(),
        }
    }
    pub fn script(&self, lists: Vec<Vec<(u32, u64)>>) {
        self.script_results(lists.into_iter().map(Ok).collect());
    }
    pub fn script_results(&self, lists: Vec<Result<Vec<(u32, u64)>, String>>) {
        *self.lists.borrow_mut() = lists.into();
    }
    pub fn proc(&self, pid: u32, created: u64, line: Option<&str>) {
        self.proc_at(pid, created, IMAGE, line)
    }
    pub fn proc_at(&self, pid: u32, created: u64, image: &str, line: Option<&str>) {
        let p = FakeProc { created, image: image.into(), line: line.map(String::from), broken: None, failing_ends: 0, end_attempts: 0, ended: false };
        self.procs.borrow_mut().insert(pid, ProcHandle(std::rc::Rc::new(std::cell::RefCell::new(p))));
    }
    /// Makes one identity read fail: "created", "image" or "same_file".
    pub fn break_identity(&self, pid: u32, which: &'static str) {
        self.procs.borrow()[&pid].0.borrow_mut().broken = Some(which);
    }
    pub fn fail_ends(&self, pid: u32, times: u32) {
        self.procs.borrow()[&pid].0.borrow_mut().failing_ends = times;
    }
    pub fn ended(&self, pid: u32) -> bool {
        self.procs.borrow()[&pid].0.borrow().ended
    }
    pub fn end_attempts(&self, pid: u32) -> u32 {
        self.procs.borrow()[&pid].0.borrow().end_attempts
    }
    pub fn polls(&self) -> usize {
        self.polls.get()
    }
    pub fn sleeps(&self) -> Vec<std::time::Duration> {
        self.sleeps.borrow().clone()
    }
    pub fn clock(&self) -> std::time::Duration {
        self.clock.get()
    }
}

impl super::monitor::System for FakeSystem {
    fn cs2_list(&self) -> Result<Vec<super::monitor::Listed>, String> {
        self.polls.set(self.polls.get() + 1);
        if self.panic_on_polls.borrow().contains(&self.polls.get()) {
            panic!("staged watcher failure");
        }
        let mut l = self.lists.borrow_mut();
        let next = if l.len() > 1 { l.pop_front().unwrap() } else { l.front().cloned().unwrap_or(Ok(Vec::new())) };
        // A process that was ended is gone from the list, as on Windows.
        let procs = self.procs.borrow();
        let gone = |pid: &u32| procs.get(pid).is_some_and(|p| p.0.borrow().ended);
        next.map(|v| v.into_iter().filter(|(pid, _)| !gone(pid)).map(|(pid, created)| super::monitor::Listed { pid, created }).collect())
    }
    fn open(&self, pid: u32) -> Result<Option<Box<dyn super::monitor::Cs2Process>>, String> {
        Ok(self.procs.borrow().get(&pid).cloned().map(|p| Box::new(p) as Box<dyn super::monitor::Cs2Process>))
    }
    fn same_file(&self, a: &Path, b: &Path) -> Result<bool, String> {
        if a.as_os_str() == UNREADABLE_IMAGE || b.as_os_str() == UNREADABLE_IMAGE {
            return Err("file identity unreadable".into());
        }
        Ok(a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()))
    }
    fn file_time(&self) -> u64 {
        if let Some(f) = self.on_file_time.borrow().as_ref() {
            f();
        }
        1000
    }
    fn elapsed(&self) -> std::time::Duration {
        self.clock.get()
    }
    fn sleep(&self, d: std::time::Duration) {
        self.sleeps.borrow_mut().push(d);
        self.clock.set(self.clock.get() + d);
    }
    fn alive(&self, pid: u32, created: u64) -> bool {
        self.alive.borrow().contains(&(pid, created))
    }
    fn this_process(&self) -> super::monitor::Listed {
        super::monitor::Listed { pid: 1, created: 1 }
    }
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
