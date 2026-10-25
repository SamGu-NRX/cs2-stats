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
use super::process::fake::{Broken, Running};
use super::process::ProcessProbe;
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
    assert_eq!(read(&layout, "cfg/my_bot_normal_config.cfg"), "bot_difficulty 5 // v1.4.7\r\n");
    assert!(!layout.target("Panel v1.4.7.exe").exists(), "the Panel is never installed");
    assert_eq!(read(&layout, "cfg/autoexec.cfg"), USER_AUTOEXEC);
    assert_eq!(read(&layout, USER_SKELETON), "user skeleton");
    // The user's value wins; the convar the user had not set is added; the comment stays.
    assert_eq!(
        read(&layout, "cfg/gamemode_competitive_server.cfg"),
        "// mine\r\nbr_dropped_knife_skins 1\r\nbr_player_music_kit 33\r\nbr_dropped_knife_premium 0\r\n"
    );
    let gi = read(&layout, "gameinfo.gi");
    assert!(gameinfo::is_bot_mode(&gi).unwrap());
    assert!(gi.contains("NewValveLayer"));

    let skipped: Vec<_> = r.summary.skipped.iter().map(|k| k.path.as_str()).collect();
    assert_eq!(skipped, ["Panel v1.4.7.exe", "gameinfo.gi"]);
    assert_eq!(r.summary.kept, ["addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c", "cfg/autoexec.cfg"]);
    let st = state::load(&layout).unwrap();
    let official = st.official.unwrap();
    assert_eq!(official.tag, "v1.4.7");
    assert_eq!(official.source.url, format!("https://github.com/ed0ard/CS2-Bot-Improver/tree/{}", "a".repeat(40)));
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
    let steam = s.0.join("Steam");
    write(&steam.join("steam.exe"), b"");
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
            ("launch", launch::prepare(&layout, probe, &steam).map(|_| ())),
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
    let mut cs = ChangeSet::begin(&layout, &CLOSED, "test").unwrap();
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
    let mut cs = ChangeSet::begin(&layout, &CLOSED, "test").unwrap();
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
    let mut cs = ChangeSet::begin(&layout, &CLOSED, "test").unwrap();
    cs.put_bytes("cfg/server.cfg", b"new").unwrap();
    let id = cs.id().to_string();
    drop(cs); // no commit: the process died here
    let journal = layout.backups().join(&id).join("entries.jsonl");
    let mut text = fs::read_to_string(&journal).unwrap();
    text.push_str("{\"path\":\"cfg/torn"); // a line cut off mid-write
    fs::write(&journal, text).unwrap();

    changes::rollback(&layout, &CLOSED, None).unwrap();
    assert_eq!(read(&layout, "cfg/server.cfg"), "// valve\r\n");
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
                "build": "bin\\Release\\net10.0"
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
    assert_eq!(st.bot_mode, Some(true));
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
    assert!(st.warnings.iter().any(|w| w.contains("lack -insecure")), "{:?}", st.warnings);
    assert_eq!((snapshot(&layout.csgo), snapshot(&layout.data)), before);
}

#[test]
fn launch_turns_bot_mode_back_on_and_refuses_without_the_mod() {
    let s = Scratch::new("launch");
    let steam = s.0.join("Steam");
    write(&steam.join("steam.exe"), b"");
    let bare = fake_game(&s);
    let err = launch::prepare(&bare, &CLOSED, &steam).unwrap_err();
    assert!(err.contains("not installed"), "{err}");

    let s2 = Scratch::new("launch2");
    let layout = installed(&s2);
    // A CS2 update rewrote gameinfo.gi without the bot search paths.
    write(&layout.target("gameinfo.gi"), gameinfo::ONLINE_SAMPLE.as_bytes());
    let plan = launch::prepare(&layout, &CLOSED, &steam).unwrap();
    assert_eq!(&plan.args[..3], ["-applaunch", "730", "-insecure"]);
    assert!(plan.bot_mode_change.is_some());
    assert!(gameinfo::is_bot_mode(&read(&layout, "gameinfo.gi")).unwrap());
}
