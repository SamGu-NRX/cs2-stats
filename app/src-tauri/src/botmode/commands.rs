//! Tauri commands for the Bot Mode view. Each finds CS2 through Steam, unless `game` names
//! the `game\csgo` folder, and runs off the UI thread. Every command that changes anything goes
//! through [`mutating`], which first runs session cleanup (`session::guard`). Every command that
//! only reads goes through [`reading`], which gives up after [`READ_LIMIT`], so a Steam library
//! on a drive that stopped answering shows as unreachable instead of a page that never loads.
//! Typed wrappers are in `app/src/botmode/`.

use super::changes::{self, Meta, RollbackReport};
use super::monitor::Running;
use super::overlay::OverlayPlan;
use super::settings::{FileSeen, Preview, ReadHashes, RepairPlan, ServerPatch, ServerSettings, UndoPlan};
use std::time::Duration;
use super::install::{self, InstallReport, ReleaseIndex};
use super::monitor;
use super::overlay::{self, OverlayReport};
use super::paths::Layout;
use super::process::{session_held, SystemProbe};
use super::session::{self, RecoverAction, Recovered, Recovery, SessionStatus};
use super::settings::{self, AppSettings, Catalog, Cosmetics, Difficulty};
use super::status::{self, Status};
use super::{Ctx, Game};
use std::path::PathBuf;

async fn blocking<T: Send + 'static>(game: Option<String>, f: impl FnOnce(&Ctx) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = Ctx::new(game.map(|g| Game::Folder(PathBuf::from(g))).unwrap_or(Game::Steam), None)?;
        f(&ctx)
    })
    .await
    .map_err(|e| format!("Bot Mode task failed: {e}"))?
}

/// How long a read may take. Hashing a full install from a local disk takes about a second; a
/// library on a disconnected network or removable drive can block a file call for minutes.
pub const READ_LIMIT: Duration = Duration::from_secs(30);

/// Starts with this when a read gave up; the view shows "Library unreachable" for it.
pub const UNREACHABLE: &str = "Library unreachable";

/// How many reads may be under way at once (the view starts five when it opens). A read that
/// gave up keeps its thread until the blocked file call returns; past this many, a new read is
/// refused at once instead of adding another blocked thread.
const READS_AT_ONCE: usize = 12;
static READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Counts one read for as long as its thread lives.
struct ReadSlot;
impl ReadSlot {
    fn take() -> Option<ReadSlot> {
        use std::sync::atomic::Ordering;
        READS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < READS_AT_ONCE).then_some(n + 1)).ok().map(|_| ReadSlot)
    }
}
impl Drop for ReadSlot {
    fn drop(&mut self) {
        READS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// [`blocking`] for commands that only read, given up after [`READ_LIMIT`]. The read itself
/// runs on its own thread, which finishes or stays blocked on its own; nothing waits for it.
async fn reading<T: Send + 'static>(game: Option<String>, f: impl FnOnce(&Ctx) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let slot = ReadSlot::take().ok_or_else(|| {
            format!("{UNREACHABLE}: {READS_AT_ONCE} earlier reads of the CS2 install have not returned. If CS2 is on a network or removable drive, check that it is connected, then check again.")
        })?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("botmode-read".into())
            .spawn(move || {
                let _slot = slot;
                let r = Ctx::new(game.map(|g| Game::Folder(PathBuf::from(g))).unwrap_or(Game::Steam), None).and_then(|ctx| f(&ctx));
                let _ = tx.send(r);
            })
            .map_err(|e| format!("Bot Mode read could not start: {e}"))?;
        rx.recv_timeout(READ_LIMIT).unwrap_or_else(|_| {
            Err(format!(
                "{UNREACHABLE}: reading the CS2 install took longer than {} s. If CS2 is on a network or removable drive, check that it is connected, then check again.",
                READ_LIMIT.as_secs()
            ))
        })
    })
    .await
    .map_err(|e| format!("Bot Mode task failed: {e}"))?
}

/// The latest thing session cleanup told the user, shown by the Bot Mode view.
static NOTICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_notice(n: Option<String>) {
    if let (Some(n), Ok(mut slot)) = (n, NOTICE.lock()) {
        *slot = Some(n);
    }
}

fn clear_notice() {
    if let Ok(mut slot) = NOTICE.lock() {
        *slot = None;
    }
}

fn start_adopter(layout: &Layout) -> Result<(), String> {
    session::start_and_wait(layout, &monitor::Windows, session::RunMode::Adopt).map(|_| ())
}

/// The one wrapper for commands that change anything: session cleanup first (refusing while a
/// session runs), then `f`.
async fn mutating<T: Send + 'static>(game: Option<String>, f: impl FnOnce(&Ctx) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    blocking(game, move |ctx| {
        set_notice(session::guard(&ctx.layout, &monitor::Windows, &|| start_adopter(&ctx.layout))?);
        f(ctx)
    })
    .await
}

#[tauri::command]
pub async fn botmode_status(game: Option<String>) -> Result<Status, String> {
    reading(game, |ctx| status::status(&ctx.layout, &SystemProbe, ctx.install.as_ref(), ctx.steam_launch_options())).await
}

#[tauri::command]
pub async fn botmode_releases() -> Result<Vec<super::github::Release>, String> {
    tauri::async_runtime::spawn_blocking(|| super::github::releases(install::OFFICIAL_REPO))
        .await
        .map_err(|e| e.to_string())?
}

/// Downloads into the app folder only; the game is not touched, so no session cleanup.
#[tauri::command]
pub async fn botmode_download(game: Option<String>, tag: String, asset: Option<String>) -> Result<ReleaseIndex, String> {
    blocking(game, move |ctx| {
        install::download(&ctx.layout, &tag, asset.as_deref().unwrap_or(install::DEFAULT_ASSET), None).map(|c| c.index)
    })
    .await
}

#[tauri::command]
pub async fn botmode_install(game: Option<String>, tag: String, asset: Option<String>) -> Result<InstallReport, String> {
    mutating(game, move |ctx| {
        let asset = asset.as_deref().unwrap_or(install::DEFAULT_ASSET);
        let cached = match install::cached(&ctx.layout, &tag, asset) {
            Some(c) => c,
            None => install::download(&ctx.layout, &tag, asset, None)?,
        };
        install::install(&ctx.layout, &SystemProbe, &cached)
    })
    .await
}

#[tauri::command]
/// `previewed` is the hash botmode_overlay_plan gave the view; a manifest changed since is refused.
pub async fn botmode_overlay(game: Option<String>, manifest: Option<String>, previewed: Option<String>) -> Result<OverlayReport, String> {
    mutating(game, move |ctx| {
        let path = manifest.map(PathBuf::from).unwrap_or_else(|| ctx.layout.default_manifest());
        overlay::apply_checked(&ctx.layout, &SystemProbe, &path, previewed.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn botmode_rollback(game: Option<String>, id: Option<String>) -> Result<RollbackReport, String> {
    mutating(game, move |ctx| changes::rollback(&ctx.layout, &SystemProbe, id.as_deref())).await
}

#[tauri::command]
pub async fn botmode_backups(game: Option<String>) -> Result<Vec<Meta>, String> {
    reading(game, |ctx| changes::list(&ctx.layout)).await
}

/// The Bot Mode session as the view shows it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    /// Whether a supervisor holds the session lease right now.
    pub supervised: bool,
    /// The latest supervisor's status file, if any.
    pub status: Option<SessionStatus>,
    /// What session cleanup last told the user, if anything.
    pub notice: Option<String>,
    /// The recovery prompt, read from the files on every call: a session of this app died with
    /// Bot Mode on. Answer it with `botmode_recover`. `None` when there is nothing to ask, or
    /// `gameinfo.gi` cannot be read (`botmode_status` reports that).
    pub recovery: Option<Recovery>,
}

fn view(layout: &Layout) -> SessionView {
    SessionView {
        supervised: session_held(&layout.csgo).unwrap_or(false),
        status: session::read_status(layout),
        notice: NOTICE.lock().ok().and_then(|n| n.clone()),
        recovery: session::recovery(layout).ok().flatten(),
    }
}

/// Starts a supervisor process, which turns Bot Mode on, starts CS2 through Steam, watches it
/// until it exits and turns Bot Mode off. Returns once the supervisor has asked Steam (or
/// failed); follow the rest with `botmode_session`. Closing the app does not end the session.
#[tauri::command]
pub async fn botmode_launch(game: Option<String>) -> Result<SessionView, String> {
    mutating(game, |ctx| {
        let run_id = session::start_launch(
            &ctx.layout,
            &monitor::Windows,
            &|| session::start_and_wait(&ctx.layout, &monitor::Windows, session::RunMode::Launch),
            &|| start_adopter(&ctx.layout),
        )?;
        // Past "ready" means Steam has been asked (or the launch failed).
        let status = session::follow(&ctx.layout, &monitor::Windows, &run_id, &|s| s.state != "ready", &|_| {})?;
        if status.state == "failed" {
            set_notice(session::cleanup_message(&session::cleanup(&ctx.layout, &monitor::Windows, &|| start_adopter(&ctx.layout))));
            return Err(status.message);
        }
        Ok(view(&ctx.layout))
    })
    .await
}

/// The session's state: poll this while a session runs.
#[tauri::command]
pub async fn botmode_session(game: Option<String>) -> Result<SessionView, String> {
    reading(game, |ctx| Ok(view(&ctx.layout))).await
}

/// Answers the recovery prompt (`SessionView::recovery`): `action` "off" turns Bot Mode off
/// while `gameinfo.gi` still has `expect_hash`, the prompt's hash; "leave" changes nothing.
/// Either one stops the prompt. Refuses while a session runs or CS2 is running.
#[tauri::command]
pub async fn botmode_recover(game: Option<String>, action: RecoverAction, expect_hash: Option<String>) -> Result<Recovered, String> {
    mutating(game, move |ctx| {
        let r = session::recover(&ctx.layout, &SystemProbe, action, expect_hash.as_deref())?;
        clear_notice();
        Ok(r)
    })
    .await
}

#[tauri::command]
/// `seen` is the active profile as the view showed it; refused when it has changed since.
pub async fn botmode_set_difficulty(game: Option<String>, level: Difficulty, seen: Option<FileSeen>) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::set_difficulty_from(&ctx.layout, &SystemProbe, level, seen.as_ref())).await
}

/// `seen` is what the view read; the write is refused when the cfg no longer holds it.
#[tauri::command]
pub async fn botmode_set_cosmetics(game: Option<String>, cosmetics: Cosmetics, seen: Option<Cosmetics>) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::set_cosmetics_from(&ctx.layout, &SystemProbe, cosmetics, seen)).await
}

/// The installed BotRandomizer's music kits, knives and knife finish weights; reads only.
#[tauri::command]
pub async fn botmode_catalog(game: Option<String>) -> Result<Option<Catalog>, String> {
    reading(game, |ctx| settings::read_catalog(&ctx.layout.csgo)).await
}

/// What this app sets for the game: the server cfg's cosmetics and presets, and the knife file.
#[tauri::command]
pub async fn botmode_server_cfg(game: Option<String>) -> Result<ServerSettings, String> {
    reading(game, |ctx| settings::read_server(&ctx.layout)).await
}

/// What botmode_set_server_cfg would write for `patch` now, line by line; reads only.
#[tauri::command]
pub async fn botmode_server_preview(game: Option<String>, patch: ServerPatch) -> Result<Preview, String> {
    reading(game, move |ctx| settings::preview_server(&ctx.layout, &patch)).await
}

/// What Undo of settings change `id` would write, or why it would refuse; reads only.
#[tauri::command]
pub async fn botmode_server_undo_plan(game: Option<String>, id: String) -> Result<UndoPlan, String> {
    reading(game, move |ctx| settings::undo_plan(&ctx.layout, &id)).await
}

/// Undoes settings change `id` as a new change (`settings::undo_server`), refused when a setting
/// it wrote has changed since.
#[tauri::command]
pub async fn botmode_server_undo(game: Option<String>, id: String, read: Option<ReadHashes>) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::undo_server_checked(&ctx.layout, &SystemProbe, &id, read.as_ref())).await
}

/// What Repair would write for a missing knife file; reads only.
#[tauri::command]
pub async fn botmode_knife_repair_plan(game: Option<String>) -> Result<RepairPlan, String> {
    reading(game, |ctx| settings::knife_repair_plan(&ctx.layout)).await
}

/// Writes the missing knife file back; refused when it would no longer write `seen`.
#[tauri::command]
pub async fn botmode_knife_repair(game: Option<String>, seen: RepairPlan) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::repair_knife(&ctx.layout, &SystemProbe, &seen)).await
}

/// One change to the server cfg; refused, writing nothing, when it no longer holds `seen`, or,
/// with `read` (from a preview), when either file's bytes changed since.
#[tauri::command]
pub async fn botmode_set_server_cfg(game: Option<String>, patch: ServerPatch, seen: ServerSettings, read: Option<ReadHashes>) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::set_server_checked(&ctx.layout, &SystemProbe, patch, seen, read.as_ref())).await
}

/// Each CS2 of this install running now, with its VAC state from its command line. Reads only.
#[tauri::command]
pub async fn botmode_running(game: Option<String>) -> Result<Vec<Running>, String> {
    reading(game, |ctx| monitor::inspect(&monitor::Windows, &monitor::cs2_image(&ctx.layout.csgo)?)).await
}

/// What applying the overlay manifest would copy, for the confirmation. Reads only.
#[tauri::command]
pub async fn botmode_overlay_plan(game: Option<String>, manifest: Option<String>) -> Result<OverlayPlan, String> {
    reading(game, move |ctx| overlay::plan(&manifest.map(PathBuf::from).unwrap_or_else(|| ctx.layout.default_manifest()))).await
}

/// The game files a recorded change wrote, for the rollback confirmation. Reads only.
#[tauri::command]
pub async fn botmode_change_files(game: Option<String>, id: String) -> Result<Vec<String>, String> {
    reading(game, move |ctx| changes::files(&ctx.layout, &id)).await
}

/// The mod's own list of console commands and pro-team bot lineups (`Commands.txt` in its
/// repository at `tag`). The release zip does not carry it, so it comes from GitHub.
#[tauri::command]
pub async fn botmode_mod_commands(tag: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || super::github::file_text(install::OFFICIAL_REPO, &tag, "Commands.txt"))
        .await
        .map_err(|e| e.to_string())?
}

/// App settings only; the game is not touched, so no session cleanup.
#[tauri::command]
/// `seen` is the options as the view showed them; refused when they have changed since.
pub async fn botmode_set_launch_options(game: Option<String>, options: String, seen: Option<String>) -> Result<AppSettings, String> {
    blocking(game, move |ctx| settings::set_launch_options(&ctx.layout, &options, seen.as_deref())).await
}

/// At app start: session cleanup, which closes interrupted session toggles and starts watching
/// a CS2 that runs with Bot Mode on and no supervisor. It never turns Bot Mode off; a session
/// that died with Bot Mode on shows as `SessionView::recovery`. Runs off the UI thread; its
/// message is kept for the view.
pub fn on_app_start() {
    let _ = std::thread::Builder::new().name("botmode-cleanup".into()).spawn(|| {
        let Ok(ctx) = Ctx::new(Game::Steam, None) else { return };
        let c = session::cleanup(&ctx.layout, &monitor::Windows, &|| start_adopter(&ctx.layout));
        set_notice(session::cleanup_message(&c));
    });
}
