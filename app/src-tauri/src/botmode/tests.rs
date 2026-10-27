//! Bot Mode end to end on fake game trees: install, overlay, rollback, settings, status and
//! the CS2-running refusal.

use super::changes::{self, ChangeSet, Status};
use super::components;
use super::gameinfo;
use super::hash;
use super::install::{self, Cached};
use super::launch;
use super::overlay::{self, Manifest};
use super::paths::Layout;
use super::process::fake::{Broken, Running, Scripted};
use super::process::{OpLock, Phase, ProcessProbe};
use super::settings::{self, Cosmetics, Difficulty};
use super::state::{self, SourceLink};
use super::status::{self, ComponentState};
use super::testutil::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const CLOSED: Running = Running(false);

/// A release zip in the app's download folder with its index, as `download` leaves it.
fn cached_release(layout: &Layout, tag: &str) -> Cached {
    let zip = layout.releases().join(tag).join(install::DEFAULT_ASSET);
    write_zip(&zip, &release_files(tag));
    let sha = hash::file(&zip).unwrap();
    let source = SourceLink::new("https://github.com/ed0ard/CS2-Bot-Improver", tag, Some("a".repeat(40)));
    let index = install::index_zip(&zip, tag, install::DEFAULT_ASSET, &sha, source).unwrap();
    let mut index_file = zip.clone().into_os_string();
    index_file.push(".index.json");
    fs::write(index_file, serde_json::to_string(&index).unwrap()).unwrap();
    Cached { index, zip }
}

fn installed(s: &Scratch) -> Layout {
    let layout = fake_game(s);
    install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();
    layout
}

#[test]
fn install_copies_the_release_and_leaves_user_files_alone() {
    let s = Scratch::new("install");
    let layout = fake_game(&s);
    // A line Valve added to gameinfo.gi after the release was cut must survive the install.
    let valve = read(&layout, "gameinfo.gi").replace("\"SkyOccluder\"", "\"SkyOccluder\"\r\n\t\"game\" \"NewValveLayer\"");
    write(&layout.target("gameinfo.gi"), valve.as_bytes());

    let r = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();

    assert_eq!(read(&layout, "addons/counterstrikesharp/plugins/BotState/BotState.dll"), "official botstate v1.4.7");
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), format!("{RELEASE_BOT_CFG}// v1.4.7\r\n"));
    assert!(!layout.target("Panel v1.4.7.exe").exists(), "the Panel is never installed");
    assert_eq!(read(&layout, "cfg/autoexec.cfg"), USER_AUTOEXEC);
    assert_eq!(read(&layout, USER_SKELETON), "user skeleton");
    // The user's value wins; the convar the user had not set is added; the comment stays.
    assert_eq!(
        read(&layout, "cfg/gamemode_competitive_server.cfg"),
        "// mine\r\nbr_dropped_knife_skins 1\r\nbr_player_music_kit 33\r\nbr_dropped_knife_premium 0\r\n"
    );
    // Install leaves gameinfo.gi alone: Bot Mode is on only during a launched session.
    assert_eq!(read(&layout, "gameinfo.gi"), valve);

    let skipped: Vec<_> = r.summary.skipped.iter().map(|k| k.path.as_str()).collect();
    assert_eq!(skipped, ["Panel v1.4.7.exe", "gameinfo.gi"]);
    assert_eq!(r.summary.kept, ["addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c", "cfg/autoexec.cfg"]);
    let st = state::load(&layout).unwrap();
    let official = st.official.unwrap();
    assert_eq!(official.tag, "v1.4.7");
    assert_eq!(official.source.url, format!("https://github.com/ed0ard/CS2-Bot-Improver/tree/{}", "a".repeat(40)));
}

#[test]
fn install_keeps_the_users_own_lines_in_the_bot_cfgs() {
    let s = Scratch::new("botcfg");
    let layout = fake_game(&s);
    // An older release's file, with lines the Panel's Rules page put at the top.
    let mine = "mp_friendlyfire 0\r\nmp_c4timer 50\r\nbot_nades normal\r\nbot_difficulty 5\r\nexec old_buy.cfg\r\nbind \\ \"subclass_create 500\"\r\n";
    write(&layout.target("cfg/my_bot_normal_config.cfg"), mine.as_bytes());

    let r = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();
    // The release's lines win except where the user set a convar; the user's other settings
    // are appended. Commands (exec) and binds come from the release.
    let want = "mp_c4timer 50\r\nbot_difficulty 5\r\nexec bot_buy.cfg\r\nbind \\ \"subclass_create 500;subclass_create 503\"\r\n// v1.4.7\r\nmp_friendlyfire 0\r\nbot_nades normal\r\n";
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), want);
    assert_eq!(r.summary.user_values_kept, ["cfg/my_bot_normal_config.cfg"]);

    // Installing again, or the next release, keeps them too.
    install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), want);
    install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.8")).unwrap();
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), want.replace("v1.4.7", "v1.4.8"));
}

#[test]
fn rollback_restores_the_game_folder_exactly() {
    let s = Scratch::new("rollback");
    let layout = fake_game(&s);
    let before = snapshot(&layout.csgo);
    install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();
    assert_ne!(snapshot(&layout.csgo), before);

    let r = changes::rollback(&layout, &CLOSED, None).unwrap();
    assert_eq!(snapshot(&layout.csgo), before);
    assert!(r.removed > 0 && r.restored > 0, "{r:?}");
    assert!(state::load(&layout).unwrap().official.is_none(), "the app state goes back too");
    assert!(changes::rollback(&layout, &CLOSED, None).is_err(), "nothing left to roll back");
}

#[test]
fn install_keeps_the_chosen_difficulty() {
    let s = Scratch::new("difficulty");
    let layout = installed(&s);
    assert_eq!(settings::current_difficulty(&layout.csgo).unwrap(), Some(Difficulty::Medium));
    settings::set_difficulty(&layout, &CLOSED, Difficulty::High).unwrap();
    assert_eq!(settings::current_difficulty(&layout.csgo).unwrap(), Some(Difficulty::High));

    let r = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.8")).unwrap();
    assert_eq!(read(&layout, "overrides/botprofile.vpk"), "high v1.4.8");
    assert_eq!(r.summary.difficulty_kept, Some(Difficulty::High));
}

#[test]
fn nothing_changes_while_cs2_runs_or_cannot_be_checked() {
    let s = Scratch::new("running");
    let layout = installed(&s);
    let steam = fake_steam_config(&s, Some("-novid"));
    // Something to roll back and something to overlay.
    write(&layout.target("gameinfo.gi"), gameinfo::ONLINE_SAMPLE.as_bytes());
    let manifest = s.0.join("overlay.json");
    write(&manifest, overlay::EXAMPLE.as_bytes());
    let release = cached_release(&layout, "v1.4.8");
    let before = (snapshot(&layout.csgo), changes::list(&layout).unwrap().len(), snapshot(&layout.data));

    let probes: [&dyn ProcessProbe; 2] = [&Running(true), &Broken];
    for probe in probes {
        let results = [
            ("install", install::install(&layout, probe, &release).map(|_| ())),
            ("overlay", overlay::apply(&layout, probe, &manifest).map(|_| ())),
            ("rollback", changes::rollback(&layout, probe, None).map(|_| ())),
            ("difficulty", settings::set_difficulty(&layout, probe, Difficulty::Low).map(|_| ())),
            ("cosmetics", settings::set_cosmetics(&layout, probe, Cosmetics::default()).map(|_| ())),
            ("launch", OpLock::acquire(&layout).and_then(|l| launch::prepare(&layout, probe, &steam, &l)).map(|_| ())),
        ];
        for (op, r) in results {
            let err = r.expect_err(op);
            assert!(err.contains("CS2"), "{op}: {err}");
        }
        assert_eq!((snapshot(&layout.csgo), changes::list(&layout).unwrap().len(), snapshot(&layout.data)), before);
    }
}

#[test]
fn a_failed_install_puts_back_what_it_had_written() {
    let s = Scratch::new("failed");
    let layout = fake_game(&s);
    // A folder where a release file goes: the install fails after writing addons/ files.
    fs::create_dir_all(layout.target("cfg/my_bot_normal_config.cfg")).unwrap();
    let before = snapshot(&layout.csgo);

    let err = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap_err();
    assert!(err.contains("my_bot_normal_config.cfg") && err.contains("Nothing was left changed"), "{err}");
    assert_eq!(snapshot(&layout.csgo), before);
    assert_eq!(changes::list(&layout).unwrap()[0].status, Status::Failed);
    assert!(state::load(&layout).unwrap().official.is_none());
}

#[test]
fn content_that_does_not_match_its_hash_never_replaces_a_file() {
    let s = Scratch::new("hash");
    let layout = fake_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let mut cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    let err = cs
        .put("cfg/server.cfg", &hash::bytes(b"good"), |f| std::io::Write::write_all(f, b"bad").map_err(|e| e.to_string()))
        .unwrap_err();
    assert!(err.contains("expected"), "{err}");
    assert_eq!(read(&layout, "cfg/server.cfg"), "// valve\r\n");
    assert!(!layout.target("cfg/server.cfg.botmode-tmp").exists());
}

#[test]
fn protected_files_cannot_be_replaced_through_a_change() {
    let s = Scratch::new("protected");
    let layout = fake_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let mut cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    for rel in ["cfg/autoexec.cfg", "cfg/gamemode_competitive_server.cfg", USER_SKELETON] {
        assert!(cs.put_bytes(rel, b"x").is_err(), "{rel}");
    }
    assert!(cs.put_merged_cfg("cfg/autoexec.cfg", b"x").is_err());
    assert_eq!(read(&layout, "cfg/autoexec.cfg"), USER_AUTOEXEC);
}

#[test]
fn rollback_refuses_when_a_file_changed_since_and_changes_nothing() {
    let s = Scratch::new("conflict");
    let layout = installed(&s);
    write(&layout.target("cfg/my_bot_normal_config.cfg"), b"edited by hand");
    let before = snapshot(&layout.csgo);
    let err = changes::rollback(&layout, &CLOSED, None).unwrap_err();
    assert!(err.contains("cfg/my_bot_normal_config.cfg"), "{err}");
    assert_eq!(snapshot(&layout.csgo), before);
}

#[test]
fn changes_roll_back_newest_first() {
    let s = Scratch::new("order");
    let layout = installed(&s);
    settings::set_difficulty(&layout, &CLOSED, Difficulty::Low).unwrap();
    let list = changes::list(&layout).unwrap();
    let err = changes::rollback(&layout, &CLOSED, Some(&list[1].id)).unwrap_err();
    assert!(err.contains("not the newest"), "{err}");
    changes::rollback(&layout, &CLOSED, Some(&list[0].id)).unwrap();
    assert_eq!(settings::current_difficulty(&layout.csgo).unwrap(), Some(Difficulty::Medium));
}

#[test]
fn a_change_interrupted_by_a_crash_can_be_rolled_back() {
    let s = Scratch::new("crash");
    let layout = fake_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let mut cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    cs.put_bytes("cfg/server.cfg", b"new").unwrap();
    let id = cs.id().to_string();
    drop(cs); // no commit: the process died here, and the OS released its lock
    drop(lock);
    let journal = layout.backups().join(&id).join("entries.jsonl");
    let mut text = fs::read_to_string(&journal).unwrap();
    text.push_str("{\"path\":\"cfg/torn"); // a line cut off mid-write
    fs::write(&journal, text).unwrap();

    // The next start finds it: status names it, and no new change may begin on top of it.
    let st = status::status(&layout, &CLOSED, None, None).unwrap();
    assert_eq!(st.unfinished.as_ref().map(|m| m.id.as_str()), Some(id.as_str()));
    assert!(st.warnings.iter().any(|w| w.contains("botmode rollback")), "{:?}", st.warnings);
    let err = settings::set_cosmetics(&layout, &CLOSED, Cosmetics::default()).unwrap_err();
    assert!(err.contains("is unfinished"), "{err}");

    changes::rollback(&layout, &CLOSED, None).unwrap();
    assert_eq!(read(&layout, "cfg/server.cfg"), "// valve\r\n");
    assert!(changes::unfinished(&layout).unwrap().is_none());
}

// --- overlay -------------------------------------------------------------------------

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A checkout on `fix/hold` whose commit is pushed, with a build of BotState in `bin\`.
fn fork_checkout(s: &Scratch) -> PathBuf {
    let remote = s.0.join("remote.git");
    let checkout = s.0.join("CS2-Smarter-Bot");
    fs::create_dir_all(&remote).unwrap();
    fs::create_dir_all(&checkout).unwrap();
    git(&remote, &["init", "--bare"]);
    git(&checkout, &["init"]);
    git(&checkout, &["checkout", "-b", "fix/hold"]);
    write(&checkout.join("BotState.cs"), b"// source");
    git(&checkout, &["add", "BotState.cs"]);
    git(&checkout, &["commit", "-m", "source"]);
    git(&checkout, &["remote", "add", "origin", &remote.display().to_string()]);
    git(&checkout, &["push", "-q", "origin", "fix/hold"]);
    git(&checkout, &["fetch", "-q", "origin"]);
    for f in ["BotState.dll", "BotState.deps.json", "BotState.pdb"] {
        write(&checkout.join("bin/Release/net10.0").join(f), format!("fork {f}").as_bytes());
    }
    checkout
}

fn manifest_for(s: &Scratch, checkout: &Path, branch: &str) -> PathBuf {
    manifest_pinned(s, checkout, branch, None)
}

fn manifest_pinned(s: &Scratch, checkout: &Path, branch: &str, commit: Option<&str>) -> PathBuf {
    let m = serde_json::json!({
        "version": 1,
        "entries": [{
            "name": "BotState",
            "target": "addons/counterstrikesharp/plugins/BotState",
            "files": ["BotState.dll", "BotState.deps.json", "BotState.pdb"],
            "source": {
                "kind": "local",
                "repo": "SamGu-NRX/CS2-Smarter-Bot",
                "branch": branch,
                "checkout": checkout.display().to_string(),
                "build": "bin\\Release\\net10.0",
                "commit": commit
            }
        }]
    });
    let path = s.0.join("overlay.json");
    fs::write(&path, m.to_string()).unwrap();
    path
}

#[test]
fn overlay_installs_the_build_and_records_its_source_commit() {
    let s = Scratch::new("overlay");
    let layout = installed(&s);
    let checkout = fork_checkout(&s);
    let manifest = manifest_for(&s, &checkout, "fix/hold");

    let r = overlay::apply(&layout, &CLOSED, &manifest).unwrap();
    assert_eq!(read(&layout, "addons/counterstrikesharp/plugins/BotState/BotState.dll"), "fork BotState.dll");
    let commit = git(&checkout, &["rev-parse", "HEAD"]);
    assert_eq!(r.entries[0].source.url, format!("https://github.com/SamGu-NRX/CS2-Smarter-Bot/tree/{commit}"));
    let st = state::load(&layout).unwrap();
    assert_eq!(st.overlays[0].source.commit.as_deref(), Some(commit.as_str()));

    // An official update replaces the overlay and says so; one command puts it back.
    let up = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.8")).unwrap();
    assert_eq!(up.summary.overlays_replaced, ["BotState"]);
    assert!(state::load(&layout).unwrap().overlays.is_empty());
    overlay::apply(&layout, &CLOSED, &manifest).unwrap();
    assert_eq!(read(&layout, "addons/counterstrikesharp/plugins/BotState/BotState.dll"), "fork BotState.dll");
}

#[test]
fn overlay_refuses_a_build_whose_source_link_would_be_wrong() {
    let s = Scratch::new("overlay-refuse");
    let layout = installed(&s);
    let checkout = fork_checkout(&s);
    let before = snapshot(&layout.csgo);

    let err = overlay::apply(&layout, &CLOSED, &manifest_for(&s, &checkout, "main")).unwrap_err();
    assert!(err.contains("is on branch fix/hold"), "{err}");

    write(&checkout.join("BotState.cs"), b"// edited, not committed");
    let manifest = manifest_for(&s, &checkout, "fix/hold");
    let err = overlay::apply(&layout, &CLOSED, &manifest).unwrap_err();
    assert!(err.contains("uncommitted changes"), "{err}");

    git(&checkout, &["commit", "-qam", "local only"]);
    let err = overlay::apply(&layout, &CLOSED, &manifest).unwrap_err();
    assert!(err.contains("not on any remote branch"), "{err}");

    fs::remove_file(checkout.join("bin/Release/net10.0/BotState.pdb")).unwrap();
    git(&checkout, &["push", "-q", "origin", "fix/hold"]);
    let err = overlay::apply(&layout, &CLOSED, &manifest).unwrap_err();
    assert!(err.contains("BotState.pdb not found"), "{err}");

    assert_eq!(snapshot(&layout.csgo), before);
}

#[test]
fn a_pinned_commit_allows_a_detached_build_worktree_and_nothing_else() {
    let s = Scratch::new("overlay-pin");
    let layout = installed(&s);
    let checkout = fork_checkout(&s);
    let head = git(&checkout, &["rev-parse", "HEAD"]);
    git(&checkout, &["checkout", "-q", "--detach"]);

    let err = overlay::apply(&layout, &CLOSED, &manifest_for(&s, &checkout, "fix/hold")).unwrap_err();
    assert!(err.contains("is on branch HEAD"), "detached without a pin: {err}");
    let err = overlay::apply(&layout, &CLOSED, &manifest_pinned(&s, &checkout, "fix/hold", Some(&"0".repeat(40)))).unwrap_err();
    assert!(err.contains("but the manifest pins"), "{err}");
    let err = overlay::apply(&layout, &CLOSED, &manifest_pinned(&s, &checkout, "main", Some(&head))).unwrap_err();
    assert!(err.contains("is not on main at any remote"), "{err}");

    let r = overlay::apply(&layout, &CLOSED, &manifest_pinned(&s, &checkout, "fix/hold", Some(&head))).unwrap();
    assert_eq!(r.entries[0].source.commit.as_deref(), Some(head.as_str()));
}

#[test]
fn the_bundled_example_manifest_parses() {
    let m = Manifest::parse(overlay::EXAMPLE).unwrap();
    let names: Vec<_> = m.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["BotState", "BotRandomizer", "BotBuy", "BotMatchStats"]);
}

#[test]
fn manifest_entries_that_could_write_outside_a_plugin_folder_are_rejected() {
    let entry = |target: &str, files: &str, extra: &str| {
        format!(
            r#"{{"version":1,"entries":[{{"name":"X","target":"{target}","files":[{files}],"source":{{"kind":"github-release","repo":"a/b","tag":"v1","asset":"x.zip"{extra}}}}}]}}"#
        )
    };
    assert!(Manifest::parse(&entry("addons/counterstrikesharp/plugins/X", r#""X.dll""#, "")).is_ok());
    for (why, text) in [
        ("cfg target", entry("cfg", r#""autoexec.cfg""#, "")),
        ("protected target", entry("addons/metamod/animation", r#""a""#, "")),
        ("climbing target", entry("addons/../cfg", r#""a""#, "")),
        ("file with a folder", entry("addons/x", r#""../BotState.dll""#, "")),
        ("unknown source field", entry("addons/x", r#""X.dll""#, r#","path":"C:\\x""#)),
        ("climbing subdir", entry("addons/x", r#""X.dll""#, r#","subdir":"..""#)),
    ] {
        assert!(Manifest::parse(&text).is_err(), "{why}");
    }
}

// --- settings and status -------------------------------------------------------------

fn with_catalog(layout: &Layout) {
    write(
        &layout.target("addons/counterstrikesharp/plugins/BotRandomizer/cosmetic_catalog.json"),
        br#"{"musicKits": [3, 5, 33], "musicKitNames": {"5": "Insurgency"}}"#,
    );
}

#[test]
fn cosmetics_are_merged_into_the_users_server_cfg() {
    let s = Scratch::new("cosmetics");
    let layout = fake_game(&s);
    with_catalog(&layout);
    let want = Cosmetics { dropped_knife_skins: false, dropped_knife_premium: true, music_kit: 5 };
    settings::set_cosmetics(&layout, &CLOSED, want).unwrap();
    assert_eq!(
        read(&layout, "cfg/gamemode_competitive_server.cfg"),
        "// mine\r\nbr_dropped_knife_skins 0\r\nbr_player_music_kit 5\r\nbr_dropped_knife_premium 1\r\n"
    );
    let got = settings::read_cosmetics(&layout.csgo).unwrap();
    assert!(got.cfg_present);
    assert_eq!(got.cosmetics, want);
}

#[test]
fn a_music_kit_the_plugin_does_not_know_is_refused_without_writing() {
    let s = Scratch::new("music");
    let layout = fake_game(&s);
    let kit = |id| Cosmetics { music_kit: id, ..Cosmetics::default() };
    let err = settings::set_cosmetics(&layout, &CLOSED, kit(5)).unwrap_err();
    assert!(err.contains("cannot check music kit"), "no catalog: {err}");
    with_catalog(&layout);
    assert!(settings::set_cosmetics(&layout, &CLOSED, kit(9999)).is_err());
    assert_eq!(read(&layout, "cfg/gamemode_competitive_server.cfg"), USER_SERVER_CFG);
    settings::set_cosmetics(&layout, &CLOSED, kit(-1)).unwrap();
}

#[test]
fn status_reports_each_component_against_the_installed_release() {
    let s = Scratch::new("status");
    let layout = installed(&s);
    write(&layout.target("cfg/my_bot_normal_config.cfg"), b"mp_friendlyfire 0\r\n");
    write(&layout.target("addons/counterstrikesharp/plugins/BotMatchStats/BotMatchStats.dll"), b"hand copied");
    write(&layout.target("addons/BotHider/logs/today.log"), b"log line");

    let st = status::status(&layout, &CLOSED, None, Some("-insecure".into())).unwrap();
    let state_of = |name: &str| st.components.iter().find(|c| c.name == name).map(|c| c.state);
    assert_eq!(state_of(components::METAMOD), Some(ComponentState::Official));
    assert_eq!(state_of("BotState"), Some(ComponentState::Official));
    assert_eq!(state_of("BotMatchStats"), Some(ComponentState::NotInRelease));
    assert_eq!(state_of("BotHider"), None, "logs are not a component");
    let cfgs = st.components.iter().find(|c| c.name == components::CFGS).unwrap();
    assert_eq!((cfgs.state, cfgs.differs.as_slice()), (ComponentState::Modified, ["cfg/my_bot_normal_config.cfg".to_string()].as_slice()));
    assert_eq!(st.release.installed.as_ref().map(|i| i.tag.as_str()), Some("v1.4.7"));
    assert_eq!(st.bot_mode, Some(false), "install does not turn Bot Mode on");
    let protected: Vec<_> = st.protected.keys().map(String::as_str).collect();
    assert_eq!(protected, ["addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c", "cfg/autoexec.cfg", "cfg/gamemode_competitive_server.cfg"]);
    assert!(st.warnings.is_empty(), "{:?}", st.warnings);
}

#[test]
fn status_finds_the_version_of_a_hand_installed_mod_and_writes_nothing() {
    let s = Scratch::new("status-detect");
    let layout = fake_game(&s);
    // Installed the README way, by copying the zip's files: no app state.
    for (rel, data) in release_files("v1.4.6") {
        if !rel.ends_with(".exe") {
            write(&layout.target(&rel), &data);
        }
    }
    cached_release(&layout, "v1.4.6");
    cached_release(&layout, "v1.4.7");
    let before = (snapshot(&layout.csgo), snapshot(&layout.data));

    let st = status::status(&layout, &CLOSED, None, Some("-novid".into())).unwrap();
    assert!(st.release.installed.is_none());
    assert_eq!(st.release.reference.as_deref(), Some("v1.4.6 (CS2BotImprover.zip)"));
    assert_eq!(st.release.matching, st.release.total);
    // Hand-installed the README way, so gameinfo.gi has Bot Mode on with nothing watching.
    assert!(st.warnings.iter().any(|w| w.contains("no session watching CS2") && w.contains("VAC on") && w.contains(super::session::UNPROTECTED)), "{:?}", st.warnings);
    assert_eq!((snapshot(&layout.csgo), snapshot(&layout.data)), before);
}

#[test]
fn launch_refuses_without_the_mod_and_always_carries_insecure() {
    let s = Scratch::new("launch");
    let steam = fake_steam_config(&s, Some("-novid -insecure"));
    let bare = fake_game(&s);
    let lock = OpLock::acquire(&bare).unwrap();
    let err = launch::prepare(&bare, &CLOSED, &steam, &lock).unwrap_err();
    assert!(err.contains("not installed"), "{err}");

    let s2 = Scratch::new("launch2");
    let layout = installed(&s2);
    let lock = OpLock::acquire(&layout).unwrap();
    let plan = launch::prepare(&layout, &CLOSED, &steam, &lock).unwrap();
    assert_eq!(&plan.args[..3], ["-applaunch", "730", "-insecure"]);
    assert!(!gameinfo::is_bot_mode(&read(&layout, "gameinfo.gi")).unwrap(), "preparing does not turn Bot Mode on");
}

// --- round 1 review: process checks, lock, confinement, Steam options, zip limits, races ----

#[test]
fn launch_refuses_secure_in_steams_own_options_and_rechecks_before_starting() {
    let s = Scratch::new("launch-secure");
    let steam = fake_steam_config(&s, Some("-novid"));
    let layout = installed(&s);
    let before = snapshot(&layout.csgo);
    let lock = OpLock::acquire(&layout).unwrap();
    // Steam's file stores a quoted token as \"-secure\".
    for form in ["-novid -SECURE +exec autoexec", "+secure", "--secure", "-secure=1", "-secure", "-novid \\\"-secure\\\""] {
        write(&steam.localconfig, localconfig(form).as_bytes());
        let err = launch::prepare(&layout, &CLOSED, &steam, &lock).unwrap_err();
        assert!(err.contains("in Steam contain") && err.contains("VAC"), "{form}: {err}");
    }
    assert_eq!(snapshot(&layout.csgo), before);

    // CS2 starting between the preparation and the hand-off to Steam stops the launch.
    write(&steam.localconfig, localconfig("-novid").as_bytes());
    let plan = launch::prepare(&layout, &CLOSED, &steam, &lock).unwrap();
    let err = launch::check_start(&plan, &layout, &Running(true), &steam).unwrap_err();
    assert!(err.contains("CS2 started"), "{err}");

    // So does -secure added in Steam meanwhile: start reads the options again.
    write(&steam.localconfig, localconfig("-novid -secure").as_bytes());
    let err = launch::check_start(&plan, &layout, &CLOSED, &steam).unwrap_err();
    assert!(err.contains("in Steam contain"), "{err}");
}

#[test]
fn launch_refuses_when_steams_launch_options_cannot_be_read() {
    let s = Scratch::new("launch-unread");
    let layout = installed(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let missing = fake_steam_config(&s, None);
    let err = launch::prepare(&layout, &CLOSED, &missing, &lock).unwrap_err();
    assert!(err.contains("could not read CS2's launch options"), "missing localconfig.vdf: {err}");
    write(&missing.localconfig, b"\"UserLocalConfigStore\"\n{\n");
    let err = launch::prepare(&layout, &CLOSED, &missing, &lock).unwrap_err();
    assert!(err.contains("could not read CS2's launch options"), "unreadable localconfig.vdf: {err}");

    // Prepared fine, then the file went away before the hand-off.
    write(&missing.localconfig, localconfig("").as_bytes());
    let plan = launch::prepare(&layout, &CLOSED, &missing, &lock).unwrap();
    fs::remove_file(&missing.localconfig).unwrap();
    assert!(launch::check_start(&plan, &layout, &CLOSED, &missing).is_err());
}

#[test]
fn a_second_operation_cannot_run_while_one_holds_the_lock() {
    let s = Scratch::new("lock");
    let layout = installed(&s);
    let before = snapshot(&layout.csgo);
    let held = OpLock::acquire(&layout).unwrap();
    let results = [
        ("install", install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.8")).map(|_| ())),
        ("rollback", changes::rollback(&layout, &CLOSED, None).map(|_| ())),
        ("difficulty", settings::set_difficulty(&layout, &CLOSED, Difficulty::High).map(|_| ())),
    ];
    for (op, r) in results {
        let err = r.expect_err(op);
        assert!(err.contains("another Bot Mode operation"), "{op}: {err}");
    }
    assert_eq!(snapshot(&layout.csgo), before);
    drop(held);
    settings::set_difficulty(&layout, &CLOSED, Difficulty::High).unwrap();
}

#[test]
fn rollback_rechecks_cs2_after_its_first_pass() {
    let s = Scratch::new("rollback-recheck");
    let layout = installed(&s);
    let before = snapshot(&layout.csgo);
    // Closed when rollback starts, running by the time it would write.
    let err = changes::rollback(&layout, &Scripted(|p| p == Phase::Rollback), None).unwrap_err();
    assert!(err.contains("CS2 is running"), "{err}");
    assert_eq!(snapshot(&layout.csgo), before);
}

#[test]
fn rollback_leaves_a_file_another_program_changed_during_it() {
    let s = Scratch::new("rollback-race");
    let layout = installed(&s);
    let edited = layout.target("cfg/my_bot_normal_config.cfg");
    // Between rollback's first pass and its writes, something else saves this file.
    let probe = Scripted(move |p| {
        if p == Phase::Rollback {
            fs::write(&edited, b"saved by another program").unwrap();
        }
        false
    });
    let err = changes::rollback(&layout, &probe, None).unwrap_err();
    assert!(err.contains("cfg/my_bot_normal_config.cfg changed while the rollback ran"), "{err}");
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), "saved by another program");
    // A rollback that stopped part-way never claims the change is still complete: it is
    // pending, nothing new may start on top of it, and the game may not be launched.
    let pending = changes::unfinished(&layout).unwrap().expect("the half-undone change is pending");
    assert_eq!(pending.status, Status::RollbackPending);
    assert!(settings::set_cosmetics(&layout, &CLOSED, Cosmetics::default()).unwrap_err().contains("is unfinished"));
}

#[test]
fn launch_refuses_while_a_change_is_unfinished() {
    let s = Scratch::new("launch-unfinished");
    let steam = fake_steam_config(&s, Some("-novid"));
    let layout = installed(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let plan = launch::prepare(&layout, &CLOSED, &steam, &lock).unwrap();
    // A change left interrupted (the process died before committing it).
    let cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    drop(cs);
    for err in [launch::prepare(&layout, &CLOSED, &steam, &lock).unwrap_err(), launch::check_start(&plan, &layout, &CLOSED, &steam).unwrap_err()] {
        assert!(err.contains("is unfinished") && err.contains("botmode rollback` first"), "{err}");
    }
}

#[test]
fn a_change_record_without_its_journal_rolls_back_cleanly() {
    let s = Scratch::new("no-journal");
    let layout = fake_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    let dir = cs.dir().to_path_buf();
    drop(cs);
    drop(lock);
    // A record from a crash between writing meta.json and creating the journal.
    fs::remove_file(dir.join("entries.jsonl")).unwrap();
    changes::rollback(&layout, &CLOSED, None).unwrap();
    assert!(changes::unfinished(&layout).unwrap().is_none());
}

#[cfg(windows)]
#[test]
fn writes_never_follow_a_junction_out_of_the_game_folder() {
    let s = Scratch::new("junction");
    let layout = fake_game(&s);
    let outside = s.0.join("outside");
    fs::create_dir_all(&outside).unwrap();
    junction(&layout.target("addons/counterstrikesharp"), &outside);

    let err = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap_err();
    assert!(err.contains("junction or symbolic link"), "{err}");
    assert!(snapshot(&outside).is_empty(), "nothing was written through the junction");

    // The temporary file next to a target is checked too.
    fs::remove_dir(layout.target("addons/counterstrikesharp")).unwrap();
    junction(&layout.target("cfg/server.cfg.botmode-tmp"), &outside);
    let lock = OpLock::acquire(&layout).unwrap();
    let mut cs = ChangeSet::begin(&layout, &CLOSED, &lock, "test").unwrap();
    let err = cs.put_bytes("cfg/server.cfg", b"x").unwrap_err();
    assert!(err.contains("botmode-tmp is a junction"), "{err}");
    assert_eq!(read(&layout, "cfg/server.cfg"), "// valve\r\n");
}

/// A release zip plus `extra` entries, written with `method`.
fn zip_with(path: &Path, extra: &[(&str, Vec<u8>)], method: zip::CompressionMethod) {
    let mut files = release_files("v1.4.7");
    for (name, data) in extra {
        files.insert(name.to_string(), data.clone());
    }
    let mut z = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let opts = zip::write::SimpleFileOptions::default().compression_method(method);
    for (name, data) in &files {
        z.start_file(name.as_str(), opts).unwrap();
        std::io::Write::write_all(&mut z, data).unwrap();
    }
    z.finish().unwrap();
}

fn index(path: &Path) -> Result<install::ReleaseIndex, String> {
    install::index_zip(path, "v1.4.7", install::DEFAULT_ASSET, "0", SourceLink::new("https://github.com/x/y", "v1.4.7", None))
}

#[test]
fn a_zip_that_unpacks_far_past_its_size_is_refused() {
    let s = Scratch::new("bomb");
    let path = s.0.join("bomb.zip");
    // 64 MB of zeros deflates to about 64 KB: a thousand times its packed size.
    zip_with(&path, &[("addons/bomb.bin", vec![0u8; 64 << 20])], zip::CompressionMethod::Deflated);
    assert!(fs::metadata(&path).unwrap().len() < 1 << 20);
    let err = index(&path).unwrap_err();
    assert!(err.contains("unpacks to more than") && err.contains("ten times its own size"), "{err}");
}

#[test]
fn an_entry_larger_than_its_declared_size_is_refused() {
    let s = Scratch::new("declared");
    let path = s.0.join("liar.zip");
    let name = "addons/liar.bin";
    zip_with(&path, &[(name, vec![b'A'; 1000])], zip::CompressionMethod::Stored);
    // Rewrite the entry's uncompressed size to 10 bytes in its local and central headers.
    let mut bytes = fs::read(&path).unwrap();
    let mut patched = 0;
    let mut at = 0;
    while let Some(pos) = bytes[at..].windows(name.len()).position(|w| w == name.as_bytes()).map(|p| p + at) {
        if pos >= 46 && bytes[pos - 46..pos - 42] == [0x50, 0x4b, 0x01, 0x02] {
            bytes[pos - 46 + 24..pos - 46 + 28].copy_from_slice(&10u32.to_le_bytes());
            patched += 1;
        } else if pos >= 30 && bytes[pos - 30..pos - 26] == [0x50, 0x4b, 0x03, 0x04] {
            bytes[pos - 30 + 22..pos - 30 + 26].copy_from_slice(&10u32.to_le_bytes());
            patched += 1;
        }
        at = pos + 1;
    }
    assert_eq!(patched, 2);
    fs::write(&path, bytes).unwrap();
    let err = index(&path).unwrap_err();
    assert!(err.contains("more than its declared size of 10 bytes"), "{err}");
}

// --- round 2 review: unfinished rollbacks, game-keyed lock, commit failure, identity, reads ----

/// A fake game where install fails part-way: a folder sits where a release cfg goes, so the
/// addons/ files are written before the failure.
fn failing_install(s: &Scratch) -> Layout {
    let layout = fake_game(s);
    fs::create_dir_all(layout.target("cfg/my_bot_normal_config.cfg")).unwrap();
    layout
}

#[test]
fn an_automatic_rollback_waits_while_cs2_runs_and_can_be_finished_later() {
    let s = Scratch::new("abort-cs2");
    let layout = failing_install(&s);
    let before = snapshot(&layout.csgo);
    // Closed for install's own checks, running by the time of the automatic rollback.
    let err = install::install(&layout, &Scripted(|p| p == Phase::AutomaticRollback), &cached_release(&layout, "v1.4.7")).unwrap_err();
    let pending = changes::unfinished(&layout).unwrap().expect("left pending");
    assert_eq!(pending.status, Status::RollbackPending);
    assert!(err.contains("CS2 is running") && err.contains(&format!("botmode rollback {}", pending.id)), "{err}");
    // Nothing was put back while CS2 ran.
    assert_eq!(read(&layout, "addons/metamod.vdf"), String::from_utf8(release_files("v1.4.7")["addons/metamod.vdf"].clone()).unwrap());

    changes::rollback(&layout, &CLOSED, Some(&pending.id)).unwrap();
    assert_eq!(snapshot(&layout.csgo), before);
}

#[test]
fn a_partly_undone_change_stays_reachable_until_it_is_fully_rolled_back() {
    let s = Scratch::new("abort-partial");
    let layout = failing_install(&s);
    let before = snapshot(&layout.csgo);
    let victim = layout.target("addons/metamod.vdf");
    let saved = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let keep = saved.clone();
    // During the automatic rollback, another program rewrites a file the install wrote.
    let probe = Scripted(move |p| {
        if p == Phase::AutomaticRollback {
            *keep.lock().unwrap() = fs::read(&victim).unwrap();
            fs::write(&victim, b"another program").unwrap();
        }
        false
    });
    let err = install::install(&layout, &probe, &cached_release(&layout, "v1.4.7")).unwrap_err();
    let pending = changes::unfinished(&layout).unwrap().expect("left pending");
    assert_eq!(pending.status, Status::RollbackPending);
    assert!(err.contains("changed while the rollback ran") && err.contains(&pending.id), "{err}");

    // Once the file is back as Bot Mode wrote it, the named rollback finishes the job.
    fs::write(layout.target("addons/metamod.vdf"), saved.lock().unwrap().as_slice()).unwrap();
    changes::rollback(&layout, &CLOSED, Some(&pending.id)).unwrap();
    assert_eq!(snapshot(&layout.csgo), before);
    assert!(changes::unfinished(&layout).unwrap().is_none());
}

#[test]
fn a_failure_to_finish_the_change_rolls_it_back() {
    let s = Scratch::new("commit-fail");
    let layout = fake_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let err = changes::run(&layout, &CLOSED, &lock, "test", |cs| {
        cs.put_bytes("cfg/server.cfg", b"changed")?;
        // Recording the finished change will need this name for its temporary file.
        fs::create_dir_all(cs.dir().join("meta.json.botmode-tmp")).unwrap();
        Ok(())
    })
    .unwrap_err();
    assert!(err.contains("finishing the change failed"), "{err}");
    assert_eq!(read(&layout, "cfg/server.cfg"), "// valve\r\n");
}

#[test]
fn two_app_folders_cannot_work_on_one_game_folder_at_once() {
    let s = Scratch::new("lock-data");
    let a = installed(&s);
    let b = Layout { csgo: a.csgo.clone(), data: s.0.join("other-data") };
    let held = OpLock::acquire(&a).unwrap();
    let err = OpLock::acquire(&b).err().expect("second app folder refused");
    assert!(err.contains("is working on"), "{err}");
    let err = settings::set_difficulty(&b, &CLOSED, Difficulty::High).unwrap_err();
    assert!(err.contains("is working on"), "{err}");
    drop(held);
    OpLock::acquire(&b).unwrap();
}

#[test]
fn a_named_game_folder_must_be_cs2s() {
    let s = Scratch::new("game-identity");
    let fake = fake_game(&s); // ...\game\csgo, but not under steamapps\common\Counter-Strike Global Offensive
    let err = super::Ctx::new(super::Game::Folder(fake.csgo.clone()), Some(s.0.join("data"))).err().expect("refused");
    assert!(err.contains("which is not a"), "{err}");
    let real_shape = s.0.join("steamapps").join("common").join("Counter-Strike Global Offensive").join("game").join("csgo");
    write(&real_shape.join("gameinfo.gi"), b"\"GameInfo\" {}");
    assert!(super::steam::check_game_folder(&real_shape).is_ok());
}

#[test]
fn the_manifest_is_only_created_new_inside_the_app_folder() {
    let s = Scratch::new("init-manifest");
    let layout = fake_game(&s);
    let outside = s.0.join("elsewhere");
    fs::create_dir_all(&outside).unwrap();
    let err = overlay::init_manifest(&layout, &outside.join("overlay.json")).unwrap_err();
    assert!(err.contains("inside the app folder"), "{err}");
    assert!(!outside.join("overlay.json").exists());

    overlay::init_manifest(&layout, &layout.default_manifest()).unwrap();
    assert_eq!(fs::read_to_string(layout.default_manifest()).unwrap(), overlay::EXAMPLE);
    write(&layout.default_manifest(), b"{\"mine\": true}");
    assert!(overlay::init_manifest(&layout, &layout.default_manifest()).unwrap_err().contains("already exists"));
    assert_eq!(fs::read_to_string(layout.default_manifest()).unwrap(), "{\"mine\": true}");
}

#[cfg(windows)]
#[test]
fn reads_never_follow_a_junction_out_of_the_game_folder() {
    let s = Scratch::new("read-junction");
    let layout = fake_game(&s);
    // The catalog the music kit is checked against sits behind a junction.
    let outside = s.0.join("outside");
    write(&outside.join("cosmetic_catalog.json"), br#"{"musicKits": [5]}"#);
    fs::create_dir_all(layout.target("addons/counterstrikesharp/plugins")).unwrap();
    junction(&layout.target("addons/counterstrikesharp/plugins/BotRandomizer"), &outside);
    let err = settings::set_cosmetics(&layout, &CLOSED, Cosmetics { music_kit: 5, ..Cosmetics::default() }).unwrap_err();
    assert!(err.contains("junction or symbolic link"), "{err}");
    assert_eq!(read(&layout, "cfg/gamemode_competitive_server.cfg"), USER_SERVER_CFG);
}

#[test]
fn folders_can_be_flushed_without_administrator_rights() {
    let s = Scratch::new("flush");
    assert_eq!(super::paths::flush_dir(&s.0), Ok(true));
}

#[test]
fn launch_needs_cs2_found_through_steam() {
    let s = Scratch::new("no-steam");
    let why = "Steam is not installed (no SteamPath in the registry)".to_string();
    let ctx = super::Ctx { layout: fake_game(&s), install: None, discovery_error: Some(why.clone()) };
    let err = ctx.steam_config().unwrap_err();
    assert!(err.contains("will not launch") && err.contains(&why), "the cause is kept: {err}");
}

// --- round 3 review -------------------------------------------------------------------------

#[test]
fn a_named_game_folder_must_be_the_install_steam_reports() {
    let s = Scratch::new("same-install");
    // Steam reports CS2 in one library; a copy with the right shape sits in another.
    let lib = |name: &str| s.0.join(name).join("steamapps").join("common").join("Counter-Strike Global Offensive").join("game").join("csgo");
    let (reported, other) = (lib("C"), lib("Z"));
    for d in [&reported, &other] {
        write(&d.join("gameinfo.gi"), b"\"GameInfo\" {}");
    }
    let install = super::steam::Cs2Install {
        steam: s.0.join("Steam"),
        library: s.0.join("C"),
        csgo: reported.clone(),
        build_id: None,
        owner: Some(76_561_197_961_265_729),
    };
    let err = super::same_install(&other, Ok(install.clone())).unwrap_err();
    assert!(err.contains(&other.canonicalize().unwrap().display().to_string()), "names the --game folder: {err}");
    assert!(err.contains(&reported.canonicalize().unwrap().display().to_string()), "names Steam's folder: {err}");
    assert_eq!(super::same_install(&reported, Ok(install)).unwrap().csgo, reported);
    let err = super::same_install(&reported, Err("Steam is not installed".into())).unwrap_err();
    assert!(err.contains("omit --game"), "{err}");
}

#[cfg(windows)]
#[test]
fn status_reports_a_junction_and_does_not_read_through_it() {
    let s = Scratch::new("status-junction");
    let layout = installed(&s);
    let outside = s.0.join("outside");
    write(&outside.join("Evil.dll"), b"not ours");
    junction(&layout.target("addons/counterstrikesharp/plugins/Evil"), &outside);
    let st = status::status(&layout, &CLOSED, None, Some("-insecure".into())).unwrap();
    assert!(st.components.iter().all(|c| c.name != "Evil"), "the junction's files are not listed");
    assert!(
        st.warnings.iter().any(|w| w.contains("addons/counterstrikesharp/plugins/Evil is a junction")),
        "{:?}",
        st.warnings
    );
}

#[test]
fn status_repeats_the_durability_warnings_of_recorded_changes() {
    let s = Scratch::new("status-warnings");
    let layout = installed(&s);
    let meta_path = layout.backups().join(&changes::list(&layout).unwrap()[0].id).join("meta.json");
    let mut meta: changes::Meta = serde_json::from_str(&fs::read_to_string(&meta_path).unwrap()).unwrap();
    meta.warnings.push("Windows would not flush folder X to disk".into());
    fs::write(&meta_path, serde_json::to_string(&meta).unwrap()).unwrap();
    let st = status::status(&layout, &CLOSED, None, Some("-insecure".into())).unwrap();
    assert!(st.warnings.iter().any(|w| w.contains(&meta.id) && w.contains("would not flush")), "{:?}", st.warnings);
}

#[test]
fn new_folders_are_listed_deepest_first_for_flushing() {
    let s = Scratch::new("ancestors");
    let deep = s.0.join("a").join("b").join("c");
    assert_eq!(super::paths::missing_ancestors(&deep), [deep.clone(), s.0.join("a").join("b"), s.0.join("a")]);
    fs::create_dir_all(s.0.join("a")).unwrap();
    assert_eq!(super::paths::missing_ancestors(&deep), [deep.clone(), s.0.join("a").join("b")]);
}

// --- round 4 review -------------------------------------------------------------------------

#[test]
fn a_change_that_only_updates_the_app_state_can_still_be_rolled_back() {
    let s = Scratch::new("state-only");
    let layout = fake_game(&s);
    // Installed by hand from the same zip: every game file already matches the release.
    for (rel, data) in release_files("v1.4.7") {
        if !rel.ends_with(".exe") {
            write(&layout.target(&rel), &data);
        }
    }
    let r = install::install(&layout, &CLOSED, &cached_release(&layout, "v1.4.7")).unwrap();
    assert_eq!(r.change.files, 0, "no game file needed writing");
    assert!(state::load(&layout).unwrap().official.is_some());
    assert_eq!(changes::list(&layout).unwrap().len(), 1, "the state change is recorded");
    changes::rollback(&layout, &CLOSED, None).unwrap();
    assert!(state::load(&layout).unwrap().official.is_none(), "rollback put the app state back");
}

#[cfg(windows)]
#[test]
fn the_game_lock_is_machine_wide() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::OpenMutexW;
    let s = Scratch::new("global-lock");
    let layout = fake_game(&s);
    let _lock = OpLock::acquire(&layout).unwrap();
    let key = super::hash::bytes(layout.csgo.canonicalize().unwrap().to_string_lossy().to_lowercase().as_bytes());
    let exists = |scope: &str| {
        let name: Vec<u16> = format!("{scope}{}cs2-stats-botmode-{}", '\u{5c}', &key[..32]).encode_utf16().chain(Some(0)).collect();
        // SAFETY: NUL-terminated name; the handle, if any, is closed at once.
        unsafe {
            let h = OpenMutexW(0x0010_0000, 0, name.as_ptr());
            if !h.is_null() {
                CloseHandle(h);
            }
            !h.is_null()
        }
    };
    assert!(exists("Global"), "the lock is in the Global namespace");
    assert!(!exists("Local"), "and never in the per-session one");
}

// --- round 6 review: one supervisor process, liveness by lease -----------------------------

use super::monitor::Outcome as Watch;
use super::process::{session_held, LockKind, NamedLock};
use super::session::{self, Cleanup, RunMode};

/// An installed fake game with the game executable in place, and that executable's path as
/// the fake system's processes report it.
fn session_game(s: &Scratch) -> (Layout, String) {
    let layout = installed(s);
    write(&layout.csgo.join("..").join("bin").join("win64").join("cs2.exe"), b"MZ cs2");
    let image = super::monitor::cs2_image(&layout.csgo).unwrap().display().to_string();
    (layout, image)
}

fn bot_mode_on(layout: &Layout) -> bool {
    gameinfo::is_bot_mode(&read(layout, "gameinfo.gi")).unwrap()
}

fn turn_on_by_hand(layout: &Layout) {
    write(&layout.target("gameinfo.gi"), gameinfo::enable(gameinfo::ONLINE_SAMPLE).unwrap().as_bytes());
}

const NO_ADOPTER: &dyn Fn() -> Result<(), String> = &|| panic!("no adopter should be started");

const CHILD_ENV: &str = "CS2STATS_TEST_LEASE_CHILD";

/// Not a test on its own: run as a child process by the lease test, it holds the session lease
/// for the game folder named in its environment until it is killed.
#[test]
fn lease_child_process_holds_the_lease() {
    let Ok(csgo) = std::env::var(CHILD_ENV) else { return };
    let _lease = NamedLock::acquire(LockKind::Session, Path::new(&csgo)).unwrap();
    println!("LEASE-HELD");
    std::io::Write::flush(&mut std::io::stdout()).unwrap();
    std::thread::sleep(std::time::Duration::from_secs(120));
}

#[test]
fn the_session_lease_is_freed_when_its_process_dies() {
    use std::io::BufRead;
    let s = Scratch::new("lease");
    let layout = fake_game(&s);
    assert!(!session_held(&layout.csgo).unwrap());
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "botmode::tests::lease_child_process_holds_the_lease", "--nocapture", "--test-threads=1"])
        .env(CHILD_ENV, &layout.csgo)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("LEASE-HELD") {
                let _ = tx.send(());
            }
        }
    });
    rx.recv_timeout(std::time::Duration::from_secs(60)).expect("the child took the lease");
    assert!(session_held(&layout.csgo).unwrap(), "held while the child lives");
    let err = NamedLock::acquire(LockKind::Session, &layout.csgo).err().expect("a second holder is refused");
    assert!(err.contains("already running"), "{err}");
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(!session_held(&layout.csgo).unwrap(), "the OS freed the lease when the process died");
    NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
}

#[test]
fn a_supervisor_turns_bot_mode_on_for_its_session_and_off_when_cs2_exits() {
    let s = Scratch::new("supervisor");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, image) = session_game(&s);
    let sys = FakeSystem::new();
    sys.script(vec![vec![], vec![(10, 2000)], vec![(10, 2000)], vec![]]);
    sys.proc_at(10, 2000, &image, Some(SAFE_LINE));
    let on_at_spawn = std::cell::Cell::new(false);
    let held_at_spawn = std::cell::Cell::new(false);
    let spawn = |_: &launch::LaunchPlan| {
        on_at_spawn.set(bot_mode_on(&layout));
        held_at_spawn.set(session_held(&layout.csgo).unwrap());
        Ok(())
    };
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "run-1", &spawn);
    assert!(on_at_spawn.get() && held_at_spawn.get(), "on, and leased, when Steam was asked");
    assert_eq!(st.state, "done", "{}", st.message);
    assert!(matches!(st.outcome, Some(Watch::Exited { .. })));
    assert!(st.bot_mode_on.is_some() && st.bot_mode_off.is_some() && st.left_on.is_none());
    assert!(!bot_mode_on(&layout), "off once CS2 exited");
    assert!(!session_held(&layout.csgo).unwrap(), "the lease ends with the supervisor");
    let file = session::read_status(&layout).unwrap();
    assert_eq!((file.run_id.as_str(), file.state.as_str()), ("run-1", "done"));
}

#[test]
fn a_supervisor_that_cannot_ask_steam_turns_bot_mode_off_again() {
    let s = Scratch::new("supervisor-spawn");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    let st = session::supervise_session(&layout, &CLOSED, &FakeSystem::new(), Some(&steam), RunMode::Launch, "r", &|_| Err("steam.exe: not found".into()));
    assert_eq!(st.state, "failed");
    assert!(st.message.contains("turned off again"), "{}", st.message);
    assert!(!bot_mode_on(&layout));
}

#[test]
fn a_second_supervisor_for_the_same_game_changes_nothing() {
    let s = Scratch::new("supervisor-twice");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    let _first = NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
    let before = snapshot(&layout.csgo);
    let st = session::supervise_session(&layout, &CLOSED, &FakeSystem::new(), Some(&steam), RunMode::Launch, "r", &|_| panic!("must not spawn"));
    assert_eq!(st.state, "failed");
    assert!(st.message.contains("already running"), "{}", st.message);
    assert_eq!(snapshot(&layout.csgo), before);
    assert!(session::read_status(&layout).is_none(), "the losing supervisor wrote no status");
}

#[test]
fn a_launch_where_cs2_never_starts_turns_bot_mode_off() {
    let s = Scratch::new("supervisor-nostart");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "r", &|_| Ok(()));
    assert!(matches!(st.outcome, Some(Watch::NoStart { .. })), "{:?}", st.outcome);
    assert!(sys.clock() >= session::START_LIMIT);
    assert!(!bot_mode_on(&layout));
}

#[test]
fn a_process_list_outage_shows_in_the_status_file() {
    let s = Scratch::new("supervisor-outage");
    let (layout, image) = session_game(&s);
    turn_on_by_hand(&layout);
    let sys = FakeSystem::new();
    let mut lists: Vec<Result<Vec<(u32, u64)>, String>> = vec![Ok(vec![(10, 5)])];
    lists.extend(vec![Err("snapshot failed".into()); 12]);
    lists.push(Ok(vec![]));
    sys.script_results(lists);
    sys.proc_at(10, 5, &image, Some(SAFE_LINE));
    let st = session::supervise_session(&layout, &CLOSED, &sys, None, RunMode::Adopt, "r", &|_| Ok(()));
    assert!(st.errors.iter().any(|e| e.contains("keeps failing")), "{:?}", st.errors);
    assert!(bot_mode_on(&layout), "adoption does not take ownership");
}

#[test]
fn cleanup_leaves_a_leased_session_alone() {
    let s = Scratch::new("cleanup-leased");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let _lease = NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
    assert!(matches!(session::cleanup(&layout, &CLOSED, &FakeSystem::new(), NO_ADOPTER), Cleanup::Supervised));
    assert!(bot_mode_on(&layout));
    // And commands that change anything wait for it.
    let err = session::guard(&layout, &CLOSED, &FakeSystem::new(), NO_ADOPTER).unwrap_err();
    assert!(err.contains("session is running"), "{err}");
}

#[test]
fn cleanup_leaves_bot_mode_another_tool_left_on_and_says_so() {
    let s = Scratch::new("cleanup-panel");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let c = session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER);
    assert!(matches!(&c, Cleanup::LeftAlone { message } if message == session::MANAGED_BY_OTHER_TOOL), "{c:?}");
    assert!(bot_mode_on(&layout));
}

fn mark_dead_session(layout: &Layout, before: &str, after: &str, run_id: &str) {
    let marker = serde_json::json!({"state": "committed", "run_id": run_id, "ownership": "ours", "before_hash": super::hash::bytes(before.as_bytes()), "after_hash": super::hash::bytes(after.as_bytes()), "before_content": before});
    write(&session::marker_path(layout), marker.to_string().as_bytes());
}

fn mark_pending_session(layout: &Layout, before: &str, after: &str, run_id: &str) {
    let marker = serde_json::json!({"state": "pending", "run_id": run_id, "ownership": "ours", "before_hash": super::hash::bytes(before.as_bytes()), "after_hash": super::hash::bytes(after.as_bytes()), "before_content": before});
    write(&session::marker_path(layout), marker.to_string().as_bytes());
}

#[test]
fn cleanup_after_a_crash_before_the_gameinfo_write_clears_pending_intent() {
    let s = Scratch::new("pending-before-write");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    mark_pending_session(&layout, before, &after, "dead");
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER), Cleanup::Off));
    assert!(!bot_mode_on(&layout));
    assert!(!session::marker_path(&layout).is_file());
}

#[test]
fn cleanup_after_a_crash_after_the_gameinfo_write_reverts_pending_intent() {
    let s = Scratch::new("pending-after-write");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    write(&layout.target("gameinfo.gi"), after.as_bytes());
    mark_pending_session(&layout, before, &after, "dead");
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER), Cleanup::TurnedOff { .. }));
    assert_eq!(read(&layout, "gameinfo.gi"), before);
}

#[test]
fn cleanup_reverts_a_dead_session_leftover() {
    let s = Scratch::new("cleanup-ours");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    write(&layout.target("gameinfo.gi"), after.as_bytes());
    mark_dead_session(&layout, before, &after, "dead");
    let sys = FakeSystem::new(); sys.script(vec![vec![]]);
    let c = session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER);
    assert!(matches!(c, Cleanup::TurnedOff { .. }));
    assert_eq!(read(&layout, "gameinfo.gi"), before);
}

#[test]
fn cleanup_leaves_our_leftover_that_changed_afterwards() {
    let s = Scratch::new("cleanup-changed");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    let changed = after.replace("SkyOccluder", "ChangedByAnotherTool");
    write(&layout.target("gameinfo.gi"), changed.as_bytes());
    mark_dead_session(&layout, before, &after, "dead");
    let sys = FakeSystem::new(); sys.script(vec![vec![]]);
    let c = session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER);
    assert!(matches!(c, Cleanup::LeftAlone { .. }));
    assert_eq!(read(&layout, "gameinfo.gi"), changed);
}

#[test]
fn cleanup_with_no_session_marker_does_nothing() {
    let s = Scratch::new("cleanup-no-marker");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout); let before = read(&layout, "gameinfo.gi");
    let sys = FakeSystem::new(); sys.script(vec![vec![]]);
    let c = session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER);
    assert!(matches!(c, Cleanup::LeftAlone { .. }));
    assert_eq!(read(&layout, "gameinfo.gi"), before);
}

#[test]
fn a_launch_over_pre_existing_bot_mode_leaves_it_on_after_cleanup() {
    let s = Scratch::new("pre-existing"); let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s); turn_on_by_hand(&layout);
    let sys = FakeSystem::new(); sys.script(vec![vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "pre", &|_| Ok(()));
    assert_eq!(st.state, "done"); assert!(bot_mode_on(&layout));
}

#[test]
fn a_panel_rewrite_during_our_session_stays_on_after_cs2_exits() {
    let s = Scratch::new("panel-mid-session");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let changed = std::cell::RefCell::new(None::<String>);
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "ours", &|_| {
        let current = read(&layout, "gameinfo.gi");
        let panel = current.replace("SkyOccluder", "PanelRewrite");
        write(&layout.target("gameinfo.gi"), panel.as_bytes());
        *changed.borrow_mut() = Some(panel);
        Ok(())
    });
    assert_eq!(st.state, "done");
    assert_eq!(read(&layout, "gameinfo.gi"), changed.borrow().as_deref().unwrap());
    assert!(bot_mode_on(&layout));
}

#[test]
fn a_marker_write_failure_does_not_claim_bot_mode_was_turned_off() {
    let s = Scratch::new("marker-write-failure");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    fs::create_dir(session::marker_path(&layout)).unwrap();
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "ours", &|_| Ok(()));
    assert!(st.message.contains("Bot Mode was not turned on."), "{}", st.message);
    assert!(!bot_mode_on(&layout));
}

#[test]
fn a_marker_for_another_session_id_cannot_turn_bot_mode_off() {
    let s = Scratch::new("marker-run-id");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    write(&layout.target("gameinfo.gi"), after.as_bytes());
    mark_dead_session(&layout, before, &after, "other-run");
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, None, RunMode::Adopt, "our-run", &|_| Ok(()));
    assert_eq!(st.state, "done");
    assert!(bot_mode_on(&layout));
}

#[test]
fn cleanup_closes_an_interrupted_session_without_guessing_ownership() {
    let s = Scratch::new("cleanup-interrupted");
    let (layout, _) = session_game(&s);
    let id = interrupted_toggle(&layout, "bot-mode-on", &gameinfo::enable(gameinfo::ONLINE_SAMPLE).unwrap());
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER), Cleanup::LeftAlone { .. }));
    let m = changes::list(&layout).unwrap().into_iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.status, changes::Status::Superseded);
    let lock = OpLock::acquire(&layout).unwrap();
    let result = changes::run_kind(&layout, &CLOSED, &lock, "test", changes::Kind::Normal, |cs| cs.put_bytes("gameinfo.gi", read(&layout, "gameinfo.gi").as_bytes()));
    assert!(result.is_ok(), "the interrupted session no longer blocks changes: {result:?}");
}

#[test]
fn cleanup_clears_a_stale_marker_when_bot_mode_is_off() {
    let s = Scratch::new("stale-marker");
    let (layout, _) = session_game(&s);
    let before = gameinfo::ONLINE_SAMPLE;
    let after = gameinfo::enable(before).unwrap();
    mark_dead_session(&layout, before, &after, "dead");
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER), Cleanup::Off));
    assert!(!session::marker_path(&layout).is_file());
}

#[test]
fn cleanup_with_cs2_running_starts_an_adopting_supervisor_and_changes_nothing() {
    let s = Scratch::new("cleanup-adopt");
    let (layout, image) = session_game(&s);
    turn_on_by_hand(&layout);
    let sys = FakeSystem::new();
    sys.script(vec![vec![(10, 5)]]);
    sys.proc_at(10, 5, &image, Some(SAFE_LINE));
    let started = std::cell::Cell::new(0);
    let c = session::cleanup(&layout, &CLOSED, &sys, &|| {
        started.set(started.get() + 1);
        Ok(())
    });
    assert!(matches!(c, Cleanup::Adopting { .. }), "{c:?}");
    assert_eq!(started.get(), 1);
    assert!(bot_mode_on(&layout), "never changed while CS2 runs");
    // The adopting supervisor watches it and turns Bot Mode off when it exits.
    sys.script(vec![vec![(10, 5)], vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, None, RunMode::Adopt, "r", &|_| Ok(()));
    assert_eq!(st.state, "done");
    assert!(!sys.ended(10) && bot_mode_on(&layout), "adoption does not take ownership");
}

/// A session toggle left `InProgress`, as if the process died before recording it finished.
fn interrupted_toggle(layout: &Layout, op: &str, text: &str) -> String {
    let lock = OpLock::acquire(layout).unwrap();
    let (_, meta) = changes::run_kind(layout, &CLOSED, &lock, op, changes::Kind::Session, |cs| cs.put_bytes("gameinfo.gi", text.as_bytes())).unwrap();
    let path = layout.backups().join(&meta.id).join("meta.json");
    fs::write(&path, fs::read_to_string(&path).unwrap().replace("\"complete\"", "\"inProgress\"")).unwrap();
    meta.id
}

#[test]
fn an_interrupted_session_toggle_without_a_marker_is_left_alone() {
    let s = Scratch::new("recover-off");
    let (layout, _) = session_game(&s);
    let on = gameinfo::enable(gameinfo::ONLINE_SAMPLE).unwrap();
    write(&layout.target("gameinfo.gi"), on.as_bytes());
    // Interrupted while turning Bot Mode off: rolling it back would turn Bot Mode on again.
    let id = interrupted_toggle(&layout, "bot-mode-off", gameinfo::ONLINE_SAMPLE);
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, NO_ADOPTER), Cleanup::Off));
    assert!(!bot_mode_on(&layout));
    let m = changes::list(&layout).unwrap().into_iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.status, changes::Status::Superseded);
}

#[test]
fn an_interrupted_toggle_with_cs2_running_is_adopted_not_changed() {
    let s = Scratch::new("recover-adopt");
    let (layout, image) = session_game(&s);
    let on = gameinfo::enable(gameinfo::ONLINE_SAMPLE).unwrap();
    let _ = interrupted_toggle(&layout, "bot-mode-on", &on);
    let sys = FakeSystem::new();
    sys.script(vec![vec![(10, 5)]]);
    sys.proc_at(10, 5, &image, Some(SAFE_LINE));
    let adopted = std::cell::Cell::new(false);
    assert!(matches!(session::cleanup(&layout, &CLOSED, &sys, &|| { adopted.set(true); Ok(()) }), Cleanup::Adopting { .. }));
    assert!(adopted.get() && bot_mode_on(&layout));
}

#[test]
fn a_compare_and_swap_never_overwrites_a_newer_gameinfo() {
    let s = Scratch::new("cas");
    let (layout, _) = session_game(&s);
    // The primitive: a stale read is refused and nothing is written.
    let lock = OpLock::acquire(&layout).unwrap();
    let before = read(&layout, "gameinfo.gi");
    let err = changes::run(&layout, &CLOSED, &lock, "test", |cs| cs.put_bytes_if_unchanged("gameinfo.gi", b"x", &"0".repeat(64))).unwrap_err();
    assert!(err.contains(changes::CHANGED_SINCE_READ), "{err}");
    assert_eq!(read(&layout, "gameinfo.gi"), before);
    drop(lock);

    // A Valve update lands between the toggle's read and its write: the toggle reads again and
    // keeps Valve's change.
    turn_on_by_hand(&layout);
    let on = read(&layout, "gameinfo.gi");
    mark_dead_session(&layout, gameinfo::ONLINE_SAMPLE, &on, "dead");
    let gi = layout.target("gameinfo.gi");
    let updated = std::sync::atomic::AtomicBool::new(false);
    let probe = Scripted(move |p| {
        if p == Phase::ChangeBegin && !updated.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let text = fs::read_to_string(&gi).unwrap().replace("\"SkyOccluder\"", "\"SkyOccluder\"\r\n\t\"game\" \"NewValveLayer\"");
            fs::write(&gi, text).unwrap();
        }
        false
    });
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    assert!(matches!(session::cleanup(&layout, &probe, &sys, NO_ADOPTER), Cleanup::Problem { .. }));
    let now = read(&layout, "gameinfo.gi");
    assert!(now.contains("NewValveLayer"), "Valve's update was kept");
    assert!(gameinfo::is_bot_mode(&now).unwrap(), "Bot Mode remains on after another tool changed the file");
}

#[test]
fn rollback_refuses_session_changes() {
    let s = Scratch::new("rollback-session");
    let (layout, _) = session_game(&s);
    let lock = OpLock::acquire(&layout).unwrap();
    let on = gameinfo::enable(gameinfo::ONLINE_SAMPLE).unwrap();
    let (_, on_meta) = changes::run_kind(&layout, &CLOSED, &lock, "bot-mode-on", changes::Kind::Session, |cs| cs.put_bytes("gameinfo.gi", on.as_bytes())).unwrap();
    let (_, off_meta) = changes::run_kind(&layout, &CLOSED, &lock, "bot-mode-off", changes::Kind::Session, |cs| cs.put_bytes("gameinfo.gi", gameinfo::ONLINE_SAMPLE.as_bytes())).unwrap();
    drop(lock);
    for id in [&off_meta.id, &on_meta.id] {
        let err = changes::rollback(&layout, &CLOSED, Some(id)).unwrap_err();
        assert!(err.contains("never rolled back"), "{err}");
    }
    // Without an id, rollback skips them and takes off the install instead.
    let r = changes::rollback(&layout, &CLOSED, None).unwrap();
    assert!(r.operation.starts_with("install"), "{}", r.operation);
    assert!(!bot_mode_on(&layout));
}

#[test]
fn following_a_supervisor_that_died_reports_it() {
    let s = Scratch::new("follow-dead");
    let (layout, _) = session_game(&s);
    let status = serde_json::json!({
        "runId": "r9", "mode": "launch", "state": "running", "message": "watching", "verdicts": [],
        "errors": [], "heartbeat": 0, "outcome": null, "botModeOn": null, "botModeOff": null, "leftOn": null
    });
    write(&session::status_path(&layout), status.to_string().as_bytes());
    let st = session::follow(&layout, &FakeSystem::new(), "r9", &|_| false, &|_| {}).unwrap();
    assert_eq!(st.state, "failed");
    assert!(st.message.contains("stopped unexpectedly"), "{}", st.message);
}

#[test]
fn status_counts_insecure_then_secure_as_unsafe() {
    let s = Scratch::new("status-secure");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let st = status::status(&layout, &CLOSED, None, Some("-insecure".into())).unwrap();
    assert_eq!(st.notice, super::session::MANAGED_BY_OTHER_TOOL);
    let warn = |opts: &str| {
        let st = status::status(&layout, &CLOSED, None, Some(opts.into())).unwrap();
        st.warnings.iter().find(|w| w.contains("no session watching CS2")).cloned().unwrap()
    };
    assert!(warn("-insecure -secure").contains("VAC on"));
    assert!(!warn("-insecure +exec autoexec").contains("VAC on"));
    assert!(warn("-insecure").ends_with(super::session::UNPROTECTED));
}

#[cfg(windows)]
#[test]
fn file_identity_sees_the_same_file_through_another_spelling() {
    let s = Scratch::new("file-id");
    let a = s.0.join("game").join("cs2.exe");
    let b = s.0.join("other.exe");
    write(&a, b"MZ");
    write(&b, b"MZ");
    let other_spelling = s.0.join("GAME").join(".").join("CS2.EXE");
    assert_eq!(super::process::file_id(&a).unwrap(), super::process::file_id(&other_spelling).unwrap());
    assert_ne!(super::process::file_id(&a).unwrap(), super::process::file_id(&b).unwrap(), "same content, different file");
}

// --- round 7 review ------------------------------------------------------------------------

#[test]
fn a_failed_session_off_is_never_undone_back_to_on() {
    let s = Scratch::new("off-fault");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let lock = OpLock::acquire(&layout).unwrap();
    // The off write replaces gameinfo.gi, then recording the finished change fails.
    let err = changes::run_kind(&layout, &CLOSED, &lock, "bot-mode-off", changes::Kind::Session, |cs| {
        cs.put_bytes("gameinfo.gi", gameinfo::ONLINE_SAMPLE.as_bytes())?;
        fs::create_dir_all(cs.dir().join("meta.json.botmode-tmp")).unwrap();
        Ok(())
    })
    .unwrap_err();
    assert!(err.contains("not undone"), "{err}");
    assert!(!bot_mode_on(&layout), "the off write stays; the before-image (on) is not restored");
}

#[test]
fn the_supervisor_watches_a_cs2_that_appears_at_the_end_before_turning_off() {
    let s = Scratch::new("end-cs2");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, image) = session_game(&s);
    let sys = FakeSystem::new();
    // The session's CS2 exits; the final sweep finds another; that one is watched until it exits.
    sys.script(vec![vec![(10, 2000)], vec![], vec![(11, 3000)], vec![(11, 3000)], vec![]]);
    sys.proc_at(10, 2000, &image, Some(SAFE_LINE));
    sys.proc_at(11, 3000, &image, Some(SAFE_LINE));
    let st = session::supervise_session(&layout, &CLOSED, &sys, Some(&steam), RunMode::Launch, "r", &|_| Ok(()));
    assert_eq!(st.state, "done");
    assert!(st.verdicts.iter().any(|c| matches!(c, super::monitor::Checked::Safe { pid: 11, .. })), "{:?}", st.verdicts);
    assert!(!bot_mode_on(&layout) && st.left_on.is_none());
}

#[test]
fn the_supervisor_keeps_its_lease_and_retries_until_bot_mode_is_off() {
    let s = Scratch::new("end-retry");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let on = read(&layout, "gameinfo.gi");
    mark_dead_session(&layout, gameinfo::ONLINE_SAMPLE, &on, "r");
    let sys = FakeSystem::new();
    // The process list fails at the end for a while, and another operation holds the lock.
    sys.script_results(vec![Err("snapshot failed".into()), Err("snapshot failed".into()), Ok(vec![])]);
    let held = std::rc::Rc::new(std::cell::RefCell::new(Some(OpLock::acquire(&layout).unwrap())));
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let (held2, seen2, layout2) = (held.clone(), seen.clone(), layout.clone());
    *sys.on_sleep.borrow_mut() = Some(Box::new(move |n| {
        if let Some(st) = session::read_status(&layout2) {
            seen2.borrow_mut().push((st.state.clone(), st.message.clone(), session_held(&layout2.csgo).unwrap()));
        }
        if n >= 4 {
            held2.borrow_mut().take();
        }
    }));
    let st = session::supervise_session(&layout, &CLOSED, &sys, None, RunMode::Adopt, "r", &|_| Ok(()));
    assert_eq!(st.state, "done");
    assert!(!bot_mode_on(&layout) && st.left_on.is_none(), "only leaves with Bot Mode confirmed off");
    let seen = seen.borrow();
    assert!(seen.iter().any(|(state, msg, lease)| state == "closing" && msg.contains("close CS2 now") && *lease), "{seen:?}");
}

#[test]
fn a_refused_breakaway_refuses_the_launch() {
    let refused = session::spawn_result(Err(std::io::Error::from_raw_os_error(5))).unwrap_err();
    assert!(refused.contains("CREATE_BREAKAWAY_FROM_JOB") && refused.contains("not turned on"), "{refused}");
    assert!(!session::spawn_result(Err(std::io::Error::from_raw_os_error(2))).unwrap_err().contains("BREAKAWAY"));
}

fn status_file(layout: &Layout, run: &str, state: &str) {
    let status = serde_json::json!({
        "runId": run, "mode": "launch", "state": state, "message": format!("{state} message"), "verdicts": [],
        "errors": [], "heartbeat": 0, "outcome": null, "botModeOn": null, "botModeOff": null, "leftOn": null
    });
    write(&session::status_path(layout), status.to_string().as_bytes());
}

#[test]
fn a_starter_waits_for_its_own_supervisors_ready_handshake() {
    let s = Scratch::new("handshake");
    let (layout, _) = session_game(&s);
    let sys = FakeSystem::new();
    // The child exited before it said anything: a failure, never an adoption.
    let err = session::await_ready(&layout, &sys, "r1", &mut || Some(3)).unwrap_err();
    assert!(err.contains("exited early (exit code 3)"), "{err}");
    // Its own "ready" does not count while the lease is free, and the wait is bounded.
    status_file(&layout, "r1", "ready");
    let err = session::await_ready(&layout, &sys, "r1", &mut || None).unwrap_err();
    assert!(err.contains("did not report ready"), "{err}");
    assert!(sys.clock() >= session::READY_WAIT && sys.clock() < session::READY_WAIT + std::time::Duration::from_secs(1));
    // With the lease held, another run's "ready" still does not count; its own does.
    let _lease = NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
    status_file(&layout, "other", "ready");
    assert!(session::await_ready(&layout, &FakeSystem::new(), "r1", &mut || None).is_err(), "another run's handshake");
    status_file(&layout, "r1", "ready");
    assert_eq!(session::await_ready(&layout, &FakeSystem::new(), "r1", &mut || None).unwrap().state, "ready");
    status_file(&layout, "r1", "failed");
    assert_eq!(session::await_ready(&layout, &FakeSystem::new(), "r1", &mut || None).unwrap_err(), "failed message");
}

#[test]
fn no_change_runs_while_a_session_holds_the_lease() {
    let s = Scratch::new("lease-write");
    let (layout, _) = session_game(&s);
    let _lease = NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
    let before = snapshot(&layout.csgo);
    // Without the guard in front, the change itself refuses at its write boundary.
    let err = settings::set_cosmetics(&layout, &CLOSED, Cosmetics::default()).unwrap_err();
    assert!(err.contains("session is running"), "{err}");
    assert_eq!(snapshot(&layout.csgo), before);
}

#[test]
fn adopting_with_no_cs2_left_keeps_bot_mode_on() {
    let s = Scratch::new("adopt-empty");
    let (layout, _) = session_game(&s);
    turn_on_by_hand(&layout);
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let st = session::supervise_session(&layout, &CLOSED, &sys, None, RunMode::Adopt, "r", &|_| Ok(()));
    assert_eq!(st.state, "done");
    assert!(bot_mode_on(&layout));
    assert!(sys.clock() < std::time::Duration::from_secs(5), "no waiting for a CS2 that is not there");
}

#[test]
fn following_a_supervisor_that_died_while_starting_reports_it() {
    let s = Scratch::new("follow-starting");
    let (layout, _) = session_game(&s);
    for state in ["starting", "ready"] {
        status_file(&layout, "r2", state);
        let sys = FakeSystem::new();
        let st = session::follow(&layout, &sys, "r2", &|_| false, &|_| {}).unwrap();
        assert_eq!(st.state, "failed", "{state}");
        assert!(sys.clock() < std::time::Duration::from_secs(1), "{state}: reported at once");
    }
}

#[test]
fn run_ids_never_repeat() {
    let ids: std::collections::HashSet<String> = (0..1000).map(|_| session::new_run_id()).collect();
    assert_eq!(ids.len(), 1000);
}

// --- final review -------------------------------------------------------------------------

#[test]
fn a_launch_that_fails_after_bot_mode_is_on_keeps_the_lease_until_it_is_off() {
    let s = Scratch::new("after-on");
    let steam = fake_steam_config(&s, Some("-novid"));
    let (layout, _) = session_game(&s);
    // Steam cannot be asked, and the first write turning Bot Mode off again is refused
    // (a transient failure, here CS2 seeming to run at that one check).
    let begins = std::sync::atomic::AtomicUsize::new(0);
    let probe = Scripted(move |p| p == Phase::ChangeBegin && begins.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1);
    let sys = FakeSystem::new();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let (seen2, layout2) = (seen.clone(), layout.clone());
    *sys.on_sleep.borrow_mut() = Some(Box::new(move |_| seen2.borrow_mut().push((bot_mode_on(&layout2), session_held(&layout2.csgo).unwrap()))));
    let st = session::supervise_session(&layout, &probe, &sys, Some(&steam), RunMode::Launch, "r", &|_| Err("steam.exe: not found".into()));
    assert_eq!(st.state, "failed");
    assert!(st.message.contains("steam.exe: not found") && st.message.contains("turned off again"), "{}", st.message);
    assert!(!bot_mode_on(&layout), "confirmed off before the supervisor returned");
    assert!(seen.borrow().iter().any(|&(on, held)| on && held), "it retried with Bot Mode on and the lease held: {:?}", seen.borrow());
}

#[test]
fn a_launch_whose_supervisor_never_got_ready_is_cleaned_up_at_once() {
    let s = Scratch::new("start-fail");
    let (layout, _) = session_game(&s);
    // A supervisor turned Bot Mode on, then died before its handshake reached the starter.
    turn_on_by_hand(&layout);
    let on = read(&layout, "gameinfo.gi");
    mark_dead_session(&layout, gameinfo::ONLINE_SAMPLE, &on, "dead");
    let sys = FakeSystem::new();
    sys.script(vec![vec![]]);
    let err = session::start_launch(&layout, &CLOSED, &sys, &|| Err("the Bot Mode supervisor exited early (exit code 1)".into()), NO_ADOPTER).unwrap_err();
    assert!(err.contains("exited early") && err.contains("it's now off"), "{err}");
    assert!(!bot_mode_on(&layout));
}

#[test]
fn following_does_not_accept_progress_from_a_dead_supervisor() {
    let s = Scratch::new("follow-stale");
    let (layout, _) = session_game(&s);
    // Progress past "ready" in the file, but no supervisor holds the lease.
    status_file(&layout, "r3", "waiting");
    let st = session::follow(&layout, &FakeSystem::new(), "r3", &|s| s.state != "ready", &|_| {}).unwrap();
    assert_eq!(st.state, "failed", "stale progress is not taken as a launch");
}

#[test]
fn manual_rollback_waits_while_a_session_holds_the_lease() {
    let s = Scratch::new("rollback-lease");
    let (layout, _) = session_game(&s);
    let _lease = NamedLock::acquire(LockKind::Session, &layout.csgo).unwrap();
    let before = snapshot(&layout.csgo);
    let err = changes::rollback(&layout, &CLOSED, None).unwrap_err();
    assert!(err.contains("session is running"), "{err}");
    assert_eq!(snapshot(&layout.csgo), before);
}
