mod app_state;
mod local_ai;
mod models;
mod tripo;

use app_state::{app_data_dir, model_path, mutate, RuntimeState};
use models::{AppLifecycle, AppSnapshot, CharacterProfile, ChatMode, GenerationStage, LocalAiReply, OverlayMode, PetAsset, PetConfig, WidgetPosition};
use std::{fs, sync::atomic::Ordering};
use tauri::{image::Image, menu::{MenuBuilder, MenuItem}, tray::TrayIconBuilder, AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

fn show_setup(app: &AppHandle, mode: &str) {
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
        let _ = window.emit("open-setup", mode);
    }
}

fn apply_overlay(app: &AppHandle, mode: &OverlayMode) {
    if let Some(window) = app.get_webview_window("pet") { let _ = window.set_always_on_top(*mode == OverlayMode::AlwaysOnTop); }
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
    Ok(AppSnapshot { lifecycle: value.lifecycle, pet: value.pet, asset: value.asset, generation: value.generation, paused: value.paused, visible: value.visible, model_installed: model_path(&app)?.is_file(), model_download: value.model_download, widget_position: value.widget_position })
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
fn activate_pet(app: AppHandle, config: PetConfig) -> Result<(), String> {
    if config.name.trim().is_empty() || config.name.chars().count() > 28 { return Err("Pet names must contain 1–28 characters.".into()); }
    let (candidate, source, body) = {
        let state = app.state::<RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        if !matches!(value.generation.stage, GenerationStage::Completed) && value.asset.is_none() { return Err("Finish creating a pet before activating it.".into()); }
        if matches!(value.generation.stage, GenerationStage::Completed) {
            (value.generation.candidate_model_path.clone(), value.generation.candidate_source_path.clone(), value.generation.body_type.clone().unwrap_or_default())
        } else {
            let asset = value.asset.clone().ok_or("No pet asset exists")?;
            (asset.model_path, Some(asset.source_image_path), asset.body_type)
        }
    };
    let active = app_data_dir(&app)?.join("active"); fs::create_dir_all(&active).map_err(|e| e.to_string())?;
    let active_model_path = if let Some(source_model) = candidate {
        if !std::path::Path::new(&source_model).is_file() { return Err("The generated model file is missing or corrupt.".into()); }
        let model_target = active.join("pet.glb");
        if std::path::Path::new(&source_model) != model_target { fs::copy(&source_model, &model_target).map_err(|e| e.to_string())?; }
        Some(model_target.to_string_lossy().into())
    } else { None };
    let source_image = source.ok_or("The source image is missing")?;
    let source_ext = std::path::Path::new(&source_image).extension().and_then(|s| s.to_str()).unwrap_or("png");
    let image_target = active.join(format!("source.{source_ext}"));
    if std::path::Path::new(&source_image) != image_target { fs::copy(source_image, &image_target).map_err(|e| e.to_string())?; }
    let character_profile = CharacterProfile::for_body_type(&body);
    let asset = PetAsset { model_path: active_model_path, source_image_path: image_target.to_string_lossy().into(), body_type: body, character_profile, created_at: format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()) };
    mutate(&app, |state| { state.lifecycle = AppLifecycle::Ready; state.pet = Some(config.clone()); state.asset = Some(asset); state.generation = models::GenerationState { message: "Ready".into(), ..Default::default() }; state.visible = true; })?;
    set_autostart(&app, config.launch_on_startup)?;
    apply_overlay(&app, &config.overlay_mode);
    sync_chat_widget(&app, &config.chat_mode, true);
    if let Some(setup) = app.get_webview_window("setup") { let _ = setup.hide(); }
    if let Some(pet) = app.get_webview_window("pet") { let _ = pet.show(); }
    let _ = app.emit_to("pet", "pet-updated", ());
    Ok(())
}

#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) -> Result<(), String> { mutate(&app, |s| s.paused = paused) }

#[tauri::command]
fn set_overlay_mode(app: AppHandle, mode: OverlayMode) -> Result<(), String> {
    apply_overlay(&app, &mode); mutate(&app, |state| if let Some(pet) = &mut state.pet { pet.overlay_mode = mode; })
}

#[tauri::command]
fn set_cursor_passthrough(window: WebviewWindow, ignore: bool) -> Result<(), String> { window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string()) }

#[tauri::command]
fn set_launch_on_startup(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_autostart(&app, enabled)?; mutate(&app, |state| if let Some(pet) = &mut state.pet { pet.launch_on_startup = enabled; })
}

#[tauri::command]
fn ensure_local_model(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    if state.inner.lock().map_err(|_| "State unavailable")?.model_download.downloading { return Ok(()); }
    tauri::async_runtime::spawn(local_ai::install_model(app)); Ok(())
}

#[tauri::command]
async fn send_chat(app: AppHandle, message: String) -> Result<LocalAiReply, String> {
    let reply = local_ai::chat(&app, message).await?;
    let _ = app.emit_to("pet", "pet-chat-reply", reply.clone());
    Ok(reply)
}

#[tauri::command]
fn clear_conversation(app: AppHandle) -> Result<(), String> { mutate(&app, |state| { state.conversation.clear(); state.conversation_summary.clear(); }) }

#[tauri::command]
fn delete_pet(app: AppHandle) -> Result<(), String> {
    let active = app_data_dir(&app)?.join("active");
    if active.is_dir() { fs::remove_dir_all(&active).map_err(|e| format!("Could not delete the pet files: {e}"))?; }
    let _ = set_autostart(&app, false);
    mutate(&app, |state| {
        state.lifecycle = AppLifecycle::NeedsSetup;
        state.pet = None;
        state.asset = None;
        state.generation = models::GenerationState { message: "Ready".into(), ..Default::default() };
        state.conversation.clear();
        state.conversation_summary.clear();
        state.visible = false;
    })?;
    if let Some(window) = app.get_webview_window("pet") { let _ = window.hide(); }
    if let Some(window) = app.get_webview_window("chat") { let _ = window.hide(); }
    show_setup(&app, "welcome");
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
    let show = MenuItem::with_id(app, "show", "Show / Hide Pet", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause / Resume Roaming", true, None::<&str>)?;
    let top = MenuItem::with_id(app, "top", "Toggle Stay on Top", true, None::<&str>)?;
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
                if let Some(window) = app.get_webview_window("pet") { if visible { let _ = window.hide(); } else { let _ = window.show(); } }
                let _ = mutate(app, |s| s.visible = !visible);
            }
            "pause" => { let paused = app.state::<RuntimeState>().inner.lock().ok().map(|s| s.paused).unwrap_or(false); let _ = mutate(app, |s| s.paused = !paused); }
            "top" => {
                let mode = app.state::<RuntimeState>().inner.lock().ok().and_then(|s| s.pet.as_ref().map(|p| p.overlay_mode.clone())).unwrap_or(OverlayMode::AlwaysOnTop);
                let next = if mode == OverlayMode::AlwaysOnTop { OverlayMode::Normal } else { OverlayMode::AlwaysOnTop };
                apply_overlay(app, &next); let _ = mutate(app, |s| if let Some(p) = &mut s.pet { p.overlay_mode = next; });
            }
            "startup" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false); let _ = set_autostart(app, !enabled); let _ = mutate(app, |s| if let Some(p) = &mut s.pet { p.launch_on_startup = !enabled; });
            }
            "chat_mode" => {
                let current = app.state::<RuntimeState>().inner.lock().ok().and_then(|s| s.pet.as_ref().map(|p| p.chat_mode.clone())).unwrap_or_default();
                let next = if current == ChatMode::GlassWidget { ChatMode::OnClick } else { ChatMode::GlassWidget };
                let _ = mutate(app, |s| if let Some(p) = &mut s.pet { p.chat_mode = next.clone(); });
                sync_chat_widget(app, &next, true);
                let _ = app.emit_to("pet", "pet-updated", ());
                let _ = app.emit_to("chat", "pet-updated", ());
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
            if ready { if let Some(window) = app.get_webview_window("pet") { let _ = window.show(); } } else { show_setup(app, "welcome"); }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .setup(|app| {
            let loaded = app_state::load(app.handle());
            let ready = matches!(loaded.lifecycle, AppLifecycle::Ready);
            let autostart = loaded.pet.as_ref().map(|p| p.launch_on_startup).unwrap_or(false);
            let overlay = loaded.pet.as_ref().map(|p| p.overlay_mode.clone()).unwrap_or(OverlayMode::AlwaysOnTop);
            let chat_mode = loaded.pet.as_ref().map(|p| p.chat_mode.clone()).unwrap_or_default();
            app.manage(RuntimeState { inner: std::sync::Mutex::new(loaded), cancel_generation: std::sync::atomic::AtomicBool::new(false), ai: tokio::sync::Mutex::new(Default::default()) });
            build_tray(app)?;
            if autostart { let _ = app.autolaunch().enable(); } else { let _ = app.autolaunch().disable(); }
            apply_overlay(app.handle(), &overlay);
            sync_chat_widget(app.handle(), &chat_mode, ready);
            if ready { if let Some(window) = app.get_webview_window("pet") { window.show()?; } } else { show_setup(app.handle(), "welcome"); }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "setup" { if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); } }
        })
        .invoke_handler(tauri::generate_handler![get_app_snapshot, save_widget_position, start_generation, cancel_generation, use_image_candidate, activate_pet, delete_pet, discard_pet_candidate, set_paused, set_overlay_mode, set_cursor_passthrough, set_launch_on_startup, ensure_local_model, send_chat, clear_conversation])
        .run(tauri::generate_context!())
        .expect("error while running Desk Pal");
}
