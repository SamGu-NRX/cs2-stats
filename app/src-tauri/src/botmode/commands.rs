//! Tauri commands for the Bot Mode view. Each finds CS2 through Steam, unless `game` names
//! the `game\csgo` folder, and runs off the UI thread. Typed wrappers are in
//! `app/src/botmode/`.

use super::changes::{self, Meta, RollbackReport};
use super::install::{self, InstallReport, ReleaseIndex};
use super::launch::{self, LaunchPlan};
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

#[tauri::command]
pub async fn botmode_launch(game: Option<String>) -> Result<LaunchPlan, String> {
    blocking(game, |ctx| {
        launch::launch(&ctx.layout, &SystemProbe, &ctx.steam_config()?)
    })
    .await
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
