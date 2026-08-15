use crate::models::{AppLifecycle, CharacterProfile, PetRecord, PersistedState};
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
    let legacy_ok = value.asset.as_ref().map(|a| {
        std::path::Path::new(&a.source_image_path).is_file()
            && a.model_path.as_ref().map(|path| std::path::Path::new(path).is_file()).unwrap_or(true)
    }).unwrap_or(false);
    if value.pets.is_empty() && legacy_ok {
        if let (Some(config), Some(asset)) = (value.pet.clone(), value.asset.clone()) {
            let id = format!("pet-{}", asset.created_at);
            value.pets.push(PetRecord { id: id.clone(), config, asset, paused: value.paused, visible: value.visible });
            value.selected_pet_id = Some(id);
        }
    }
    value.pets.retain(|pet| {
        std::path::Path::new(&pet.asset.source_image_path).is_file()
            && pet.asset.model_path.as_ref().map(|path| std::path::Path::new(path).is_file()).unwrap_or(true)
    });
    for pet in &mut value.pets {
        if pet.asset.character_profile.capabilities.is_empty() {
            pet.asset.character_profile = CharacterProfile::for_body_type(&pet.asset.body_type);
        }
    }
    if value.selected_pet_id.as_ref().is_none_or(|id| !value.pets.iter().any(|pet| &pet.id == id)) {
        value.selected_pet_id = value.pets.first().map(|pet| pet.id.clone());
    }
    sync_selected(&mut value);
    if value.pets.is_empty() { value.lifecycle = AppLifecycle::NeedsSetup; }
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

pub fn sync_selected(value: &mut PersistedState) {
    let selected = value.selected_pet_id.as_ref().and_then(|id| value.pets.iter().find(|pet| &pet.id == id)).cloned();
    if let Some(pet) = selected {
        value.pet = Some(pet.config);
        value.asset = Some(pet.asset);
        value.paused = pet.paused;
        value.visible = pet.visible;
        value.lifecycle = AppLifecycle::Ready;
    } else {
        value.pet = None;
        value.asset = None;
        value.paused = false;
        value.visible = false;
        value.lifecycle = AppLifecycle::NeedsSetup;
    }
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
