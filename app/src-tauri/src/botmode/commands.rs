//! Tauri commands for the Bot Mode view. Each finds CS2 through Steam, unless `game` names
//! the `game\csgo` folder, and runs off the UI thread. Every command that changes anything goes
//! through [`mutating`], which first runs session cleanup (`session::guard`). Typed wrappers are
//! in `app/src/botmode/`.

use super::changes::{self, Meta, RollbackReport};
use super::install::{self, InstallReport, ReleaseIndex};
use super::monitor;
use super::overlay::{self, OverlayReport};
use super::paths::Layout;
use super::process::{session_held, SystemProbe};
use super::session::{self, SessionStatus};
use super::settings::{self, AppSettings, Cosmetics, Difficulty};
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

/// The latest thing session cleanup told the user, shown by the Bot Mode view.
static NOTICE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_notice(n: Option<String>) {
    if let (Some(n), Ok(mut slot)) = (n, NOTICE.lock()) {
        *slot = Some(n);
    }
}

fn start_adopter(layout: &Layout) -> Result<(), String> {
    session::start_and_wait(layout, &monitor::Windows, session::RunMode::Adopt).map(|_| ())
}

/// The one wrapper for commands that change anything: session cleanup first (refusing while a
/// session runs), then `f`.
async fn mutating<T: Send + 'static>(game: Option<String>, f: impl FnOnce(&Ctx) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    blocking(game, move |ctx| {
        set_notice(session::guard(&ctx.layout, &SystemProbe, &monitor::Windows, &|| start_adopter(&ctx.layout))?);
        f(ctx)
    })
    .await
}

#[tauri::command]
pub async fn botmode_status(game: Option<String>) -> Result<Status, String> {
    blocking(game, |ctx| status::status(&ctx.layout, &SystemProbe, ctx.install.as_ref(), ctx.steam_launch_options())).await
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
pub async fn botmode_overlay(game: Option<String>, manifest: Option<String>) -> Result<OverlayReport, String> {
    mutating(game, move |ctx| {
        let path = manifest.map(PathBuf::from).unwrap_or_else(|| ctx.layout.default_manifest());
        overlay::apply(&ctx.layout, &SystemProbe, &path)
    })
    .await
}

#[tauri::command]
pub async fn botmode_rollback(game: Option<String>, id: Option<String>) -> Result<RollbackReport, String> {
    mutating(game, move |ctx| changes::rollback(&ctx.layout, &SystemProbe, id.as_deref())).await
}

#[tauri::command]
pub async fn botmode_backups(game: Option<String>) -> Result<Vec<Meta>, String> {
    blocking(game, |ctx| changes::list(&ctx.layout)).await
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
}

fn view(layout: &Layout) -> SessionView {
    SessionView {
        supervised: session_held(&layout.csgo).unwrap_or(false),
        status: session::read_status(layout),
        notice: NOTICE.lock().ok().and_then(|n| n.clone()),
    }
}

/// Starts a supervisor process, which turns Bot Mode on, starts CS2 through Steam, watches it
/// until it exits and turns Bot Mode off. Returns once the supervisor has asked Steam (or
/// failed); follow the rest with `botmode_session`. Closing the app does not end the session.
#[tauri::command]
pub async fn botmode_launch(game: Option<String>) -> Result<SessionView, String> {
    mutating(game, |ctx| {
        let run_id = session::start_and_wait(&ctx.layout, &monitor::Windows, session::RunMode::Launch)?;
        // Past "ready" means Steam has been asked (or the launch failed).
        let status = session::follow(&ctx.layout, &monitor::Windows, &run_id, &|s| s.state != "ready", &|_| {})?;
        if status.state == "failed" {
            set_notice(session::cleanup_message(&session::cleanup(&ctx.layout, &SystemProbe, &monitor::Windows, &|| start_adopter(&ctx.layout))));
            return Err(status.message);
        }
        Ok(view(&ctx.layout))
    })
    .await
}

/// The session's state: poll this while a session runs.
#[tauri::command]
pub async fn botmode_session(game: Option<String>) -> Result<SessionView, String> {
    blocking(game, |ctx| Ok(view(&ctx.layout))).await
}

#[tauri::command]
pub async fn botmode_set_difficulty(game: Option<String>, level: Difficulty) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::set_difficulty(&ctx.layout, &SystemProbe, level)).await
}

#[tauri::command]
pub async fn botmode_set_cosmetics(game: Option<String>, cosmetics: Cosmetics) -> Result<Meta, String> {
    mutating(game, move |ctx| settings::set_cosmetics(&ctx.layout, &SystemProbe, cosmetics)).await
}

/// App settings only; the game is not touched, so no session cleanup.
#[tauri::command]
pub async fn botmode_set_launch_options(game: Option<String>, options: String) -> Result<AppSettings, String> {
    blocking(game, move |ctx| {
        let mut s = settings::load_app(&ctx.layout)?;
        s.launch_options = options;
        settings::save_app(&ctx.layout, &s)?;
        Ok(s)
    })
    .await
}

/// At app start: session cleanup, so Bot Mode left on with no supervisor is turned off (or the
/// running CS2 adopted). Runs off the UI thread; its message is kept for the view.
pub fn on_app_start() {
    let _ = std::thread::Builder::new().name("botmode-cleanup".into()).spawn(|| {
        let Ok(ctx) = Ctx::new(Game::Steam, None) else { return };
        let c = session::cleanup(&ctx.layout, &SystemProbe, &monitor::Windows, &|| start_adopter(&ctx.layout));
        set_notice(session::cleanup_message(&c));
    });
}
