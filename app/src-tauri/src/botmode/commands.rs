//! Tauri commands for the Bot Mode view. Each finds CS2 through Steam, unless `game` names
//! the `game\csgo` folder, and runs off the UI thread. Typed wrappers are in
//! `app/src/botmode/`.

use super::changes::{self, Meta, RollbackReport};
use super::install::{self, InstallReport, ReleaseIndex};
use super::launch::{self, LaunchPlan};
use super::monitor;
use super::session;
use super::overlay::{self, OverlayReport};
use super::process::SystemProbe;
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

#[tauri::command]
pub async fn botmode_status(game: Option<String>) -> Result<Status, String> {
    blocking(game, |ctx| status::status(&ctx.layout, &SystemProbe, &monitor::Windows, ctx.install.as_ref(), ctx.steam_launch_options())).await
}

#[tauri::command]
pub async fn botmode_releases() -> Result<Vec<super::github::Release>, String> {
    tauri::async_runtime::spawn_blocking(|| super::github::releases(install::OFFICIAL_REPO))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn botmode_download(game: Option<String>, tag: String, asset: Option<String>) -> Result<ReleaseIndex, String> {
    blocking(game, move |ctx| {
        install::download(&ctx.layout, &tag, asset.as_deref().unwrap_or(install::DEFAULT_ASSET), None).map(|c| c.index)
    })
    .await
}

#[tauri::command]
pub async fn botmode_install(game: Option<String>, tag: String, asset: Option<String>) -> Result<InstallReport, String> {
    blocking(game, move |ctx| {
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
    blocking(game, move |ctx| {
        let path = manifest.map(PathBuf::from).unwrap_or_else(|| ctx.layout.default_manifest());
        overlay::apply(&ctx.layout, &SystemProbe, &path)
    })
    .await
}

#[tauri::command]
pub async fn botmode_rollback(game: Option<String>, id: Option<String>) -> Result<RollbackReport, String> {
    blocking(game, move |ctx| changes::rollback(&ctx.layout, &SystemProbe, id.as_deref())).await
}

#[tauri::command]
pub async fn botmode_backups(game: Option<String>) -> Result<Vec<Meta>, String> {
    blocking(game, |ctx| changes::list(&ctx.layout)).await
}

/// The Bot Mode session as the app sees it, also sent as the `botmode-session` event.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// "waiting" (no CS2 yet), "running" (CS2 is being watched) or "done".
    pub phase: &'static str,
    /// What to show the user, e.g. [`monitor::WAITING`].
    pub message: String,
    /// How the session ended, once it has.
    pub end: Option<session::SessionEnd>,
}

static SESSION: std::sync::Mutex<Option<SessionState>> = std::sync::Mutex::new(None);

fn set_session(app: &tauri::AppHandle, state: SessionState) {
    use tauri::Emitter;
    if let Ok(mut c) = SESSION.lock() {
        *c = Some(state.clone());
    }
    let _ = app.emit("botmode-session", state);
}

fn progress_to(app: &tauri::AppHandle) -> impl Fn(&monitor::Event) + '_ {
    move |e| {
        let (phase, message) = match e {
            monitor::Event::Waiting { message } => ("waiting", message.clone()),
            monitor::Event::Checked { message, .. } => ("running", message.clone()),
        };
        set_session(app, SessionState { phase, message, end: None });
    }
}

fn finished(app: &tauri::AppHandle, end: session::SessionEnd) {
    let mut message = monitor::describe(&end.outcome);
    if let Some(why) = &end.left_on {
        message.push_str(&format!(" Bot Mode is still on ({why}); it is turned off once CS2 has exited."));
    }
    set_session(app, SessionState { phase: "done", message, end: Some(end) });
}

/// Turns Bot Mode on for a session and asks Steam to start CS2, then returns. A background
/// thread watches CS2 until it exits, with no time limit, and turns Bot Mode off; progress
/// arrives as `botmode-session` events and from `botmode_session`. If that thread cannot be
/// started, the launch is undone: the CS2 it started is ended and Bot Mode turned off.
#[tauri::command]
pub async fn botmode_launch(app: tauri::AppHandle, game: Option<String>) -> Result<LaunchPlan, String> {
    let (started, layout) = blocking(game, |ctx| {
        let started = session::begin(&ctx.layout, &SystemProbe, &ctx.steam_config()?, &monitor::Windows, &launch::spawn_steam)?;
        Ok((started, ctx.layout.clone()))
    })
    .await?;
    set_session(&app, SessionState { phase: "waiting", message: monitor::WAITING.into(), end: None });
    let (thread_app, thread_started, thread_layout) = (app.clone(), started.clone(), layout.clone());
    let spawned = std::thread::Builder::new().name("botmode-session".into()).spawn(move || {
        let control = session::control_until_off(&thread_layout, &|| false, &|_| {});
        let end = session::run(&thread_layout, &SystemProbe, &monitor::Windows, &thread_started, None, &control, &progress_to(&thread_app));
        finished(&thread_app, end);
    });
    if let Err(e) = spawned {
        let why = format!("the CS2 watcher could not be started ({e})");
        let message = tauri::async_runtime::spawn_blocking(move || session::abort(&layout, &SystemProbe, &monitor::Windows, &started, &why))
            .await
            .map_err(|e| e.to_string())?;
        set_session(&app, SessionState { phase: "done", message: message.clone(), end: None });
        return Err(message);
    }
    Ok(started.plan)
}

/// The latest session state, or `None` when no session has run since the app started.
#[tauri::command]
pub fn botmode_session() -> Option<SessionState> {
    SESSION.lock().ok().and_then(|c| c.clone())
}

/// At app start: Bot Mode left on with no session watching it is turned off once CS2 is not
/// running; an unsafe CS2 is ended; a safe one is adopted and watched until it exits.
pub fn on_app_start(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("botmode-cleanup".into()).spawn(move || {
        let Ok(ctx) = Ctx::new(Game::Steam, None) else { return };
        let layout = ctx.layout;
        match session::cleanup(&layout, &SystemProbe, &monitor::Windows) {
            session::Cleanup::Adopt { .. } => {
                set_session(&app, SessionState { phase: "running", message: "watching a CS2 started with Bot Mode on".into(), end: None });
                let control = session::control_until_off(&layout, &|| false, &|_| {});
                match session::adopt(&layout, &SystemProbe, &monitor::Windows, &control, &progress_to(&app)) {
                    Ok(end) => finished(&app, end),
                    Err(e) => set_session(&app, SessionState { phase: "done", message: e, end: None }),
                }
            }
            session::Cleanup::LeftOn { why, .. } => {
                set_session(&app, SessionState { phase: "done", message: format!("Bot Mode is on and could not be turned off: {why}"), end: None })
            }
            _ => {}
        }
    });
}

#[tauri::command]
pub async fn botmode_set_difficulty(game: Option<String>, level: Difficulty) -> Result<Meta, String> {
    blocking(game, move |ctx| settings::set_difficulty(&ctx.layout, &SystemProbe, level)).await
}

#[tauri::command]
pub async fn botmode_set_cosmetics(game: Option<String>, cosmetics: Cosmetics) -> Result<Meta, String> {
    blocking(game, move |ctx| settings::set_cosmetics(&ctx.layout, &SystemProbe, cosmetics)).await
}

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
