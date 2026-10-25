//! Tauri commands for the Bot Mode view. Each finds CS2 through Steam, unless `game` names
//! the `game\csgo` folder, and runs off the UI thread. Typed wrappers are in
//! `app/src/botmode/`.

use super::changes::{self, Meta, RollbackReport};
use super::install::{self, InstallReport, ReleaseIndex};
use super::launch::{self, LaunchPlan};
use super::monitor;
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
    blocking(game, |ctx| status::status(&ctx.layout, &SystemProbe, ctx.install.as_ref(), ctx.steam_launch_options())).await
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

/// The post-launch check as the app sees it, also sent as the `botmode-launch-check` event.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchCheck {
    /// "waiting" until a verdict, then "done".
    pub phase: &'static str,
    /// What to show the user, e.g. [`monitor::WAITING`].
    pub message: String,
    pub outcome: Option<monitor::Outcome>,
}

static LAUNCH_CHECK: std::sync::Mutex<Option<LaunchCheck>> = std::sync::Mutex::new(None);

fn set_check(app: &tauri::AppHandle, check: LaunchCheck) {
    use tauri::Emitter;
    if let Ok(mut c) = LAUNCH_CHECK.lock() {
        *c = Some(check.clone());
    }
    let _ = app.emit("botmode-launch-check", check);
}

/// Asks Steam to start CS2, then returns. A background thread checks every new CS2 process
/// with no time limit, until one gets a verdict or Bot Mode is turned off or rolled back; its
/// progress and result arrive as `botmode-launch-check` events and from `botmode_launch_check`.
#[tauri::command]
pub async fn botmode_launch(app: tauri::AppHandle, game: Option<String>) -> Result<LaunchPlan, String> {
    let (plan, base, layout) = blocking(game, |ctx| {
        let (plan, base) = launch::launch(&ctx.layout, &SystemProbe, &ctx.steam_config()?, &monitor::Windows)?;
        Ok((plan, base, ctx.layout.clone()))
    })
    .await?;
    set_check(&app, LaunchCheck { phase: "waiting", message: "checking the CS2 that Steam starts".into(), outcome: None });
    std::thread::spawn(move || {
        let progress = |m: &str| set_check(&app, LaunchCheck { phase: "waiting", message: m.into(), outcome: None });
        let outcome = monitor::watch(&monitor::Windows, &base, None, &|| !launch::still_bot_mode(&layout), &progress);
        set_check(&app, LaunchCheck { phase: "done", message: monitor::describe(&outcome), outcome: Some(outcome) });
    });
    Ok(plan)
}

/// The latest post-launch check, or `None` when no launch has run since the app started.
#[tauri::command]
pub fn botmode_launch_check() -> Option<LaunchCheck> {
    LAUNCH_CHECK.lock().ok().and_then(|c| c.clone())
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
