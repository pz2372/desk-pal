use crate::models::{AppLifecycle, CharacterProfile, PersistedState};
use std::{fs, path::PathBuf, sync::{atomic::AtomicBool, Mutex}};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex as AsyncMutex;

pub struct AiRuntime {
    pub child: Option<tokio::process::Child>,
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

impl Default for AiRuntime { fn default() -> Self { Self { child: None, endpoint: None, token: None } } }

pub struct RuntimeState {
    pub inner: Mutex<PersistedState>,
    pub cancel_generation: AtomicBool,
    pub ai: AsyncMutex<AiRuntime>,
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn state_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_data_dir(app)?.join("state.json")) }
pub fn model_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_data_dir(app)?.join("models/Qwen3-0.6B-Q8_0.gguf")) }

pub fn load(app: &AppHandle) -> PersistedState {
    let mut value = state_path(app).ok().and_then(|path| fs::read(path).ok()).and_then(|data| serde_json::from_slice::<PersistedState>(&data).ok()).unwrap_or_default();
    let asset_ok = value.asset.as_ref().map(|a| {
        std::path::Path::new(&a.source_image_path).is_file()
            && a.model_path.as_ref().map(|path| std::path::Path::new(path).is_file()).unwrap_or(true)
    }).unwrap_or(false);
    if !asset_ok { value.asset = None; value.pet = None; value.lifecycle = AppLifecycle::NeedsSetup; }
    if let Some(asset) = &mut value.asset {
        if asset.character_profile.capabilities.is_empty() {
            asset.character_profile = CharacterProfile::for_body_type(&asset.body_type);
        }
    }
    if matches!(value.lifecycle, AppLifecycle::Generating) {
        value.generation.message = "Generation was interrupted. Start again to continue.".into();
        value.generation.error = Some("The previous creation was interrupted before a model was ready.".into());
        value.lifecycle = if value.asset.is_some() { AppLifecycle::Ready } else { AppLifecycle::NeedsSetup };
    }
    value.model_download.downloading = false;
    value
}

pub fn save(app: &AppHandle, value: &PersistedState) -> Result<(), String> {
    let path = state_path(app)?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())
}

pub fn mutate(app: &AppHandle, f: impl FnOnce(&mut PersistedState)) -> Result<(), String> {
    let state = app.state::<RuntimeState>();
    let mut guard = state.inner.lock().map_err(|_| "Application state is unavailable".to_string())?;
    f(&mut guard);
    save(app, &guard)
}
