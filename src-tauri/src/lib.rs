mod app_state;
mod local_ai;
mod models;
mod tripo;

use app_state::{app_data_dir, model_path, mutate, sync_selected, RuntimeState};
use models::{AppLifecycle, AppSnapshot, CharacterProfile, ChatMode, GenerationStage, LocalAiReply, OverlayMode, PetAsset, PetConfig, PetRecord, WidgetPosition};
use std::{fs, sync::atomic::Ordering};
use tauri::{image::Image, menu::{MenuBuilder, MenuItem}, tray::TrayIconBuilder, AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

fn show_setup(app: &AppHandle, mode: &str) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
        let _ = window.emit("open-setup", mode);
    }
}

fn pet_window_label(id: &str) -> String { format!("pet-{id}") }

fn emit_pet_updates(app: &AppHandle) {
    for window in app.webview_windows().into_values().filter(|window| window.label().starts_with("pet-")) {
        let _ = window.emit("pet-updated", ());
    }
    let _ = app.emit_to("chat", "pet-updated", ());
}

fn sync_pet_windows(app: &AppHandle) -> Result<(), String> {
    let active_pet = {
        let state = app.state::<RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        value
            .selected_pet_id
            .as_ref()
            .and_then(|id| value.pets.iter().find(|pet| &pet.id == id))
            .cloned()
    };
    let wanted = active_pet.as_ref().map(|pet| pet_window_label(&pet.id));
    for (label, window) in app.webview_windows() {
        if label.starts_with("pet-") && wanted.as_ref() != Some(&label) { let _ = window.close(); }
    }
    if let Some(pet) = active_pet {
        let label = pet_window_label(&pet.id);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_always_on_top(pet.config.overlay_mode == OverlayMode::AlwaysOnTop);
            if pet.visible { let _ = window.show(); } else { let _ = window.hide(); }
            return Ok(());
        }
        let url = WebviewUrl::App(format!("index.html?view=pet&petId={}", pet.id).into());
        WebviewWindowBuilder::new(app, &label, url)
            .inner_size(380.0, 520.0)
            .transparent(true)
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_top(pet.config.overlay_mode == OverlayMode::AlwaysOnTop)
            .focused(false)
            .visible(pet.visible)
            .build()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn snapshot(app: &AppHandle, value: models::PersistedState) -> Result<AppSnapshot, String> {
    Ok(AppSnapshot { lifecycle: value.lifecycle, pet: value.pet, asset: value.asset, generation: value.generation, paused: value.paused, visible: value.visible, model_installed: model_path(app)?.is_file(), model_download: value.model_download, widget_position: value.widget_position, pets: value.pets, selected_pet_id: value.selected_pet_id })
}

fn sync_chat_widget(app: &AppHandle, mode: &ChatMode, ready: bool) {
    if let Some(window) = app.get_webview_window("chat") {
        if ready && *mode == ChatMode::GlassWidget { let _ = window.show(); } else { let _ = window.hide(); }
    }
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled { manager.enable() } else { manager.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_snapshot(app: AppHandle, state: State<'_, RuntimeState>) -> Result<AppSnapshot, String> {
    let value = state.inner.lock().map_err(|_| "Application state is unavailable")?.clone();
    snapshot(&app, value)
}

#[tauri::command(rename_all = "camelCase")]
fn get_pet_snapshot(app: AppHandle, state: State<'_, RuntimeState>, pet_id: String) -> Result<AppSnapshot, String> {
    let mut value = state.inner.lock().map_err(|_| "Application state is unavailable")?.clone();
    let pet = value.pets.iter().find(|pet| pet.id == pet_id).cloned().ok_or("Pet not found")?;
    value.pet = Some(pet.config);
    value.asset = Some(pet.asset);
    value.paused = pet.paused;
    value.visible = pet.visible;
    snapshot(&app, value)
}

#[tauri::command(rename_all = "camelCase")]
fn select_pet(app: AppHandle, pet_id: String) -> Result<(), String> {
    let exists = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pets.iter().any(|pet| pet.id == pet_id);
    if !exists { return Err("Pet not found".into()); }
    mutate(&app, |state| {
        state.selected_pet_id = Some(pet_id.clone());
        if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == pet_id) { pet.visible = true; }
        sync_selected(state);
    })?;
    let mode = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pet.as_ref().map(|pet| pet.chat_mode.clone()).unwrap_or_default();
    sync_pet_windows(&app)?;
    sync_chat_widget(&app, &mode, true);
    emit_pet_updates(&app);
    Ok(())
}

#[tauri::command]
fn save_widget_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() { return Err("The widget position is invalid.".into()); }
    mutate(&app, |state| state.widget_position = Some(WidgetPosition { x, y }))
}

#[tauri::command(rename_all = "camelCase")]
fn start_generation(app: AppHandle, state: State<'_, RuntimeState>, data_url: String, filename: String) -> Result<String, String> {
    if data_url.len() > 28_000_000 { return Err("The selected image is too large.".into()); }
    let safe_name: String = filename.chars().filter(|c| c.is_ascii_alphanumeric() || ['.', '-', '_'].contains(c)).take(100).collect();
    if safe_name.is_empty() { return Err("The selected filename is invalid.".into()); }
    let id = uuid::Uuid::new_v4().to_string();
    let (bytes, ext) = tripo::parse_data_url(&data_url)?;
    let candidate_dir = app_data_dir(&app)?.join("candidate").join(&id);
    fs::create_dir_all(&candidate_dir).map_err(|e| e.to_string())?;
    let source_path = candidate_dir.join(format!("source.{ext}"));
    fs::write(&source_path, bytes).map_err(|e| format!("Could not save the selected image: {e}"))?;
    state.cancel_generation.store(false, Ordering::Relaxed);
    mutate(&app, |value| {
        value.generation = models::GenerationState {
            id: Some(id.clone()),
            stage: GenerationStage::Uploading,
            progress: 2.0,
            message: "Preparing your image for 3D generation…".into(),
            candidate_source_path: Some(source_path.to_string_lossy().into()),
            body_type: Some(Default::default()),
            ..Default::default()
        };
    })?;
    let task_app = app.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move { tripo::run(task_app, task_id, data_url, safe_name).await; });
    Ok(id)
}

#[tauri::command]
fn cancel_generation(state: State<'_, RuntimeState>) { state.cancel_generation.store(true, Ordering::Relaxed); }

#[tauri::command]
fn use_image_candidate(app: AppHandle) -> Result<(), String> {
    mutate(&app, |state| {
        if state.generation.candidate_source_path.is_some() {
            state.generation.stage = GenerationStage::Completed;
            state.generation.progress = 100.0;
            state.generation.message = "Using your image as the desktop pet.".into();
            state.generation.error = None;
            state.generation.candidate_model_path = None;
            state.generation.body_type = Some(Default::default());
        }
    })
}

#[tauri::command]
fn use_model_candidate(app: AppHandle) -> Result<(), String> {
    let model_path = {
        let state = app.state::<RuntimeState>();
        let candidate = state.inner.lock().map_err(|_| "State unavailable")?.generation.candidate_model_path.clone();
        candidate
    }.ok_or("The generated 3D model is unavailable.")?;
    if !std::path::Path::new(&model_path).is_file() { return Err("The generated 3D model file is missing.".into()); }
    mutate(&app, |state| {
        state.generation.stage = GenerationStage::Completed;
        state.generation.progress = 100.0;
        state.generation.message = "Your static 3D pet is ready to preview.".into();
        state.generation.error = None;
    })
}

#[tauri::command]
fn activate_pet(app: AppHandle, config: PetConfig) -> Result<(), String> {
    if config.name.trim().is_empty() || config.name.chars().count() > 28 { return Err("Pet names must contain 1–28 characters.".into()); }
    let (is_new, candidate, source, body, selected_id) = {
        let state = app.state::<RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        if !matches!(value.generation.stage, GenerationStage::Completed) && value.selected_pet_id.is_none() { return Err("Finish creating a pet before activating it.".into()); }
        if matches!(value.generation.stage, GenerationStage::Completed) {
            (true, value.generation.candidate_model_path.clone(), value.generation.candidate_source_path.clone(), value.generation.body_type.clone().unwrap_or_default(), None)
        } else {
            let id = value.selected_pet_id.clone().ok_or("No pet is selected")?;
            let pet = value.pets.iter().find(|pet| pet.id == id).ok_or("No pet asset exists")?;
            (false, pet.asset.model_path.clone(), Some(pet.asset.source_image_path.clone()), pet.asset.body_type.clone(), Some(id))
        }
    };
    if is_new {
        let id = uuid::Uuid::new_v4().to_string();
        let active = app_data_dir(&app)?.join("pets").join(&id); fs::create_dir_all(&active).map_err(|e| e.to_string())?;
        let active_model_path = if let Some(source_model) = candidate {
            if !std::path::Path::new(&source_model).is_file() { return Err("The generated model file is missing or corrupt.".into()); }
            let model_target = active.join("pet.glb");
            fs::copy(&source_model, &model_target).map_err(|e| e.to_string())?;
            Some(model_target.to_string_lossy().into())
        } else { None };
        let source_image = source.ok_or("The source image is missing")?;
        let source_ext = std::path::Path::new(&source_image).extension().and_then(|s| s.to_str()).unwrap_or("png");
        let image_target = active.join(format!("source.{source_ext}"));
        fs::copy(source_image, &image_target).map_err(|e| e.to_string())?;
        let asset = PetAsset { model_path: active_model_path, source_image_path: image_target.to_string_lossy().into(), body_type: body.clone(), character_profile: CharacterProfile::for_body_type(&body), created_at: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()) };
        mutate(&app, |state| {
            state.pets.push(PetRecord { id: id.clone(), config: config.clone(), asset, paused: false, visible: true });
            state.selected_pet_id = Some(id.clone());
            state.generation = models::GenerationState { message: "Ready".into(), ..Default::default() };
            sync_selected(state);
        })?;
    } else if let Some(id) = selected_id {
        mutate(&app, |state| {
            if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.config = config.clone(); }
            sync_selected(state);
        })?;
    }
    let autostart = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pets.iter().any(|pet| pet.config.launch_on_startup);
    set_autostart(&app, autostart)?;
    sync_pet_windows(&app)?;
    sync_chat_widget(&app, &config.chat_mode, true);
    if let Some(setup) = app.get_webview_window("setup") { let _ = setup.hide(); }
    emit_pet_updates(&app);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn set_paused(app: AppHandle, paused: bool, pet_id: Option<String>) -> Result<(), String> {
    mutate(&app, |state| {
        let id = pet_id.clone().or_else(|| state.selected_pet_id.clone());
        if let Some(pet) = state.pets.iter_mut().find(|pet| Some(&pet.id) == id.as_ref()) { pet.paused = paused; }
        sync_selected(state);
    })
}

#[tauri::command(rename_all = "camelCase")]
fn set_overlay_mode(app: AppHandle, mode: OverlayMode, pet_id: Option<String>) -> Result<(), String> {
    mutate(&app, |state| {
        let id = pet_id.clone().or_else(|| state.selected_pet_id.clone());
        if let Some(pet) = state.pets.iter_mut().find(|pet| Some(&pet.id) == id.as_ref()) { pet.config.overlay_mode = mode.clone(); }
        sync_selected(state);
    })?;
    sync_pet_windows(&app)
}

#[tauri::command]
fn set_cursor_passthrough(window: WebviewWindow, ignore: bool) -> Result<(), String> { window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string()) }

#[tauri::command(rename_all = "camelCase")]
fn set_launch_on_startup(app: AppHandle, enabled: bool, pet_id: Option<String>) -> Result<(), String> {
    mutate(&app, |state| {
        let id = pet_id.clone().or_else(|| state.selected_pet_id.clone());
        if let Some(pet) = state.pets.iter_mut().find(|pet| Some(&pet.id) == id.as_ref()) { pet.config.launch_on_startup = enabled; }
        sync_selected(state);
    })?;
    let any_enabled = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pets.iter().any(|pet| pet.config.launch_on_startup);
    set_autostart(&app, any_enabled)
}

#[tauri::command]
fn ensure_local_model(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    if state.inner.lock().map_err(|_| "State unavailable")?.model_download.downloading { return Ok(()); }
    tauri::async_runtime::spawn(local_ai::install_model(app)); Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn send_chat(app: AppHandle, message: String, pet_id: Option<String>) -> Result<LocalAiReply, String> {
    let target_id = match pet_id {
        Some(id) => Some(id),
        None => app
            .state::<RuntimeState>()
            .inner
            .lock()
            .map_err(|_| "State unavailable")?
            .selected_pet_id
            .clone(),
    };
    let reply = local_ai::chat(&app, message, target_id.clone()).await?;
    if let Some(id) = target_id { let _ = app.emit_to(pet_window_label(&id), "pet-chat-reply", reply.clone()); }
    Ok(reply)
}

#[tauri::command]
fn clear_conversation(app: AppHandle) -> Result<(), String> { mutate(&app, |state| { state.conversation.clear(); state.conversation_summary.clear(); }) }

#[tauri::command]
fn delete_pet(app: AppHandle) -> Result<(), String> {
    let selected = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.selected_pet_id.clone().ok_or("No pet is selected")?;
    let data_dir = app_data_dir(&app)?;
    let pet_dir = data_dir.join("pets").join(&selected);
    if pet_dir.is_dir() {
        fs::remove_dir_all(&pet_dir).map_err(|e| format!("Could not delete the pet files: {e}"))?;
    } else {
        // Pets created before multi-pet support lived in the single `active` folder.
        // Only remove that exact folder when the selected record still points into it.
        let legacy_dir = data_dir.join("active");
        let selected_uses_legacy_dir = app
            .state::<RuntimeState>()
            .inner
            .lock()
            .map_err(|_| "State unavailable")?
            .pets
            .iter()
            .find(|pet| pet.id == selected)
            .is_some_and(|pet| {
                pet.asset
                    .model_path
                    .as_deref()
                    .is_some_and(|path| std::path::Path::new(path).starts_with(&legacy_dir))
                    || std::path::Path::new(&pet.asset.source_image_path).starts_with(&legacy_dir)
            });
        if selected_uses_legacy_dir && legacy_dir.is_dir() {
            fs::remove_dir_all(&legacy_dir).map_err(|e| format!("Could not delete the pet files: {e}"))?;
        }
    }
    mutate(&app, |state| {
        state.pets.retain(|pet| pet.id != selected);
        state.selected_pet_id = state.pets.first().map(|pet| pet.id.clone());
        if let Some(id) = state.selected_pet_id.clone() {
            if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.visible = true; }
        }
        state.generation = models::GenerationState { message: "Ready".into(), ..Default::default() };
        sync_selected(state);
    })?;
    let any_startup = app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pets.iter().any(|pet| pet.config.launch_on_startup);
    let _ = set_autostart(&app, any_startup);
    sync_pet_windows(&app)?;
    if app.state::<RuntimeState>().inner.lock().map_err(|_| "State unavailable")?.pets.is_empty() {
        if let Some(window) = app.get_webview_window("chat") { let _ = window.hide(); }
        show_setup(&app, "welcome");
    } else { show_setup(&app, "edit"); }
    Ok(())
}

#[tauri::command]
fn discard_pet_candidate(app: AppHandle) -> Result<(), String> {
    mutate(&app, |state| state.generation = models::GenerationState { message: "Ready".into(), ..Default::default() })
}

fn tray_icon() -> Image<'static> {
    const SIZE: usize = 36;
    const DOLPHIN: &[(f32, f32)] = &[
        (9.0, 17.0), (12.0, 14.0), (17.0, 11.0), (21.0, 9.5),
        (20.0, 3.0), (24.5, 9.0), (28.0, 9.5), (31.0, 11.0),
        (34.8, 12.4), (31.5, 14.5), (28.5, 14.7), (26.0, 17.5),
        (23.0, 20.0), (25.5, 29.0), (19.5, 22.0), (15.0, 21.8),
        (11.0, 20.0), (8.0, 19.0), (5.0, 25.5), (1.0, 27.0),
        (2.5, 21.0), (6.5, 18.2), (2.0, 14.0), (1.0, 8.5),
        (5.5, 10.5), (9.0, 16.0),
    ];
    fn inside(x: f32, y: f32, shape: &[(f32, f32)]) -> bool {
        let mut hit = false;
        let mut previous = shape.len() - 1;
        for current in 0..shape.len() {
            let (xi, yi) = shape[current];
            let (xj, yj) = shape[previous];
            if ((yi > y) != (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi { hit = !hit; }
            previous = current;
        }
        hit
    }
    let mut pixels = vec![0u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let sample_x = x as f32 + 0.5;
            let sample_y = y as f32 + 0.5;
            if inside(sample_x, sample_y, DOLPHIN) {
                let i = (y * SIZE + x) * 4;
                let eye = (sample_x - 29.0).powi(2) + (sample_y - 11.7).powi(2) < 1.2;
                if eye {
                    pixels[i] = 3; pixels[i + 1] = 10; pixels[i + 2] = 23;
                } else {
                    pixels[i] = 12; pixels[i + 1] = 76; pixels[i + 2] = 174;
                }
                pixels[i + 3] = 255;
            }
        }
    }
    Image::new_owned(pixels, SIZE as u32, SIZE as u32)
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / Hide Active Pet", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / Resume Active Pet", true, None::<&str>)?;
    let top = MenuItem::with_id(app, "top", "Toggle Active Pet on Top", true, None::<&str>)?;
    let startup = MenuItem::with_id(app, "startup", "Toggle Launch at Startup", true, None::<&str>)?;
    let chat_mode = MenuItem::with_id(app, "chat_mode", "Toggle Pet Chat / Glass Widget", true, None::<&str>)?;
    let edit = MenuItem::with_id(app, "edit", "Open Settings", true, None::<&str>)?;
    let replace = MenuItem::with_id(app, "replace", "Create New Pet", true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear", "Clear Conversation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app).items(&[&show, &pause, &top, &startup, &chat_mode, &edit, &replace, &clear, &quit]).build()?;
    TrayIconBuilder::new().icon(tray_icon()).tooltip("Desk Pal").menu(&menu).on_menu_event(|app, event| {
        match event.id().as_ref() {
            "show" => {
                let visible = app.state::<RuntimeState>().inner.lock().ok().map(|s| s.visible).unwrap_or(false);
                let _ = mutate(app, |state| { if let Some(id) = state.selected_pet_id.clone() { if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.visible = !visible; } } sync_selected(state); });
                let _ = sync_pet_windows(app);
            }
            "pause" => { let paused = app.state::<RuntimeState>().inner.lock().ok().map(|s| s.paused).unwrap_or(false); let _ = mutate(app, |state| { if let Some(id) = state.selected_pet_id.clone() { if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.paused = !paused; } } sync_selected(state); }); emit_pet_updates(app); }
            "top" => {
                let is_top = app.state::<RuntimeState>().inner.lock().ok().and_then(|s| s.pet.as_ref().map(|pet| pet.overlay_mode == OverlayMode::AlwaysOnTop)).unwrap_or(false);
                let next = if is_top { OverlayMode::Normal } else { OverlayMode::AlwaysOnTop };
                let _ = mutate(app, |state| { if let Some(id) = state.selected_pet_id.clone() { if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.config.overlay_mode = next.clone(); } } sync_selected(state); });
                let _ = sync_pet_windows(app);
            }
            "startup" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false); let _ = set_autostart(app, !enabled); let _ = mutate(app, |state| { for pet in &mut state.pets { pet.config.launch_on_startup = !enabled; } sync_selected(state); });
            }
            "chat_mode" => {
                let current = app.state::<RuntimeState>().inner.lock().ok().and_then(|s| s.pet.as_ref().map(|p| p.chat_mode.clone())).unwrap_or_default();
                let next = if current == ChatMode::GlassWidget { ChatMode::OnClick } else { ChatMode::GlassWidget };
                let _ = mutate(app, |state| { if let Some(id) = state.selected_pet_id.clone() { if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.config.chat_mode = next.clone(); } } sync_selected(state); });
                sync_chat_widget(app, &next, true);
                emit_pet_updates(app);
            }
            "edit" => show_setup(app, "edit"),
            "replace" => show_setup(app, "replace"),
            "clear" => { let _ = mutate(app, |s| { s.conversation.clear(); s.conversation_summary.clear(); }); }
            "quit" => app.exit(0),
            _ => {}
        }
    }).build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let ready = app.state::<RuntimeState>().inner.lock().ok().map(|s| matches!(s.lifecycle, AppLifecycle::Ready)).unwrap_or(false);
            if ready { let _ = mutate(app, |state| { if let Some(id) = state.selected_pet_id.clone() { if let Some(pet) = state.pets.iter_mut().find(|pet| pet.id == id) { pet.visible = true; } } sync_selected(state); }); let _ = sync_pet_windows(app); } else { show_setup(app, "welcome"); }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .setup(|app| {
            let loaded = app_state::load(app.handle());
            let ready = matches!(loaded.lifecycle, AppLifecycle::Ready);
            let autostart = loaded.pets.iter().any(|pet| pet.config.launch_on_startup);
            let chat_mode = loaded.pet.as_ref().map(|p| p.chat_mode.clone()).unwrap_or_default();
            app.manage(RuntimeState { inner: std::sync::Mutex::new(loaded), cancel_generation: std::sync::atomic::AtomicBool::new(false), ai: tokio::sync::Mutex::new(Default::default()) });
            build_tray(app)?;
            if autostart { let _ = app.autolaunch().enable(); } else { let _ = app.autolaunch().disable(); }
            sync_chat_widget(app.handle(), &chat_mode, ready);
            if ready { sync_pet_windows(app.handle()).map_err(std::io::Error::other)?; } else { show_setup(app.handle(), "welcome"); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "setup" { if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); } }
        })
        .invoke_handler(tauri::generate_handler![get_app_snapshot, get_pet_snapshot, select_pet, save_widget_position, start_generation, cancel_generation, use_image_candidate, use_model_candidate, activate_pet, delete_pet, discard_pet_candidate, set_paused, set_overlay_mode, set_cursor_passthrough, set_launch_on_startup, ensure_local_model, send_chat, clear_conversation])
        .run(tauri::generate_context!())
        .expect("error while running Desk Pal");
}
