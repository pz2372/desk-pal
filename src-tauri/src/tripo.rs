use base64::{engine::general_purpose::STANDARD, Engine};
use crate::{app_state::{app_data_dir, mutate}, models::{BodyType, GenerationStage, RigAnalysis}};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

fn server_root() -> String {
    std::env::var("DESK_PAL_SERVER_URL")
        .ok()
        .or_else(|| option_env!("DESK_PAL_SERVER_URL").map(str::to_string))
        .or_else(|| option_env!("NOCTURNE_SERVER_URL").map(str::to_string))
        .unwrap_or_else(|| "https://desk-pal-blender.onrender.com".into())
        .trim_end_matches('/')
        .to_string()
}

#[derive(Deserialize)]
struct CreatedJob { id: String, token: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteJob {
    stage: String,
    progress: f32,
    message: String,
    error: Option<String>,
    body_type: Option<String>,
    rig_analysis: Option<RigAnalysis>,
    base_model_url: Option<String>,
    model_url: Option<String>,
}

#[derive(Deserialize)]
struct ErrorResponse { error: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightImage {
    pub index: usize,
    pub angle: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightIssue {
    pub r#type: String,
    pub image_indexes: Vec<usize>,
    pub explanation: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub passed: bool,
    pub summary: String,
    pub images: Vec<PreflightImage>,
    pub issues: Vec<PreflightIssue>,
    pub anatomy: InitialAnatomyProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialAnatomyLandmark { pub name: String, pub image_index: usize, pub x: f32, pub y: f32, pub confidence: f32, pub visible: bool, pub explanation: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialAnatomyProfile { pub family: String, pub species: String, pub has_tail: bool, pub has_wings: bool, pub confidence: f32, pub explanation: String, pub landmarks: Vec<InitialAnatomyLandmark> }

fn stage(value: &str) -> GenerationStage {
    match value { "uploading" => GenerationStage::Uploading, "generating" => GenerationStage::Generating, "model_ready" => GenerationStage::ModelReady, "rig_check" => GenerationStage::RigCheck, "analyzing" => GenerationStage::Analyzing, "needs_correction" => GenerationStage::NeedsCorrection, "rigging" => GenerationStage::Rigging, "rig_ready" => GenerationStage::RigReady, "animating" => GenerationStage::Animating, "downloading" => GenerationStage::Downloading, "completed" => GenerationStage::Completed, "cancelled" => GenerationStage::Cancelled, _ => GenerationStage::Failed }
}

fn body_type(value: &str) -> BodyType {
    match value { "biped" | "humanoid" => BodyType::Biped, "quadruped" => BodyType::Quadruped, "hexapod" => BodyType::Hexapod, "octopod" => BodyType::Octopod, "avian" | "bird" => BodyType::Avian, "serpentine" => BodyType::Serpentine, "aquatic" => BodyType::Aquatic, _ => BodyType::Unknown }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    response.json::<ErrorResponse>().await.ok().and_then(|v| v.error).unwrap_or_else(|| format!("Generation service returned {status}."))
}

fn publish(app: &AppHandle) { let _ = app.emit("generation-progress", ()); }

fn remote_url(root: &str, value: &str) -> String {
    if value.starts_with("http://") || value.starts_with("https://") { value.into() } else { format!("{root}{value}") }
}

async fn download_model(client: &reqwest::Client, url: String, target: &Path) -> Result<(), String> {
    let response = client.get(url).send().await.map_err(|e| format!("Could not download the generated model: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() < 20 || &bytes[..4] != b"glTF" { return Err("The generation service returned an invalid GLB model.".into()); }
    if let Some(parent) = target.parent() { tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?; }
    tokio::fs::write(target, &bytes).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn upload_model_artifact(client: &reqwest::Client, root: &str, model: Vec<u8>) -> Result<CreatedJob, String> {
    let response = client
        .post(format!("{root}/v1/artifacts"))
        .header(reqwest::header::CONTENT_TYPE, "model/gltf-binary")
        .body(model)
        .send()
        .await
        .map_err(|e| format!("Could not upload the saved GLB artifact: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    response.json::<CreatedJob>().await.map_err(|e| format!("The artifact service returned invalid data: {e}"))
}

async fn create_artifact_job(
    client: &reqwest::Client,
    root: &str,
    endpoint: &str,
    source_job: Option<(String, String)>,
    model: Vec<u8>,
    mut payload: serde_json::Value,
) -> Result<CreatedJob, String> {
    if let (Some(source), Some(object)) = (source_job.as_ref(), payload.as_object_mut()) {
        object.insert("sourceJob".into(), serde_json::json!({ "id": source.0, "token": source.1 }));
    }
    let response = client.post(format!("{root}{endpoint}")).json(&payload).send().await.map_err(|e| format!("Could not start the processing job: {e}"))?;
    if response.status().is_success() {
        return response.json::<CreatedJob>().await.map_err(|e| format!("The processing service returned invalid job data: {e}"));
    }
    if !matches!(response.status().as_u16(), 404 | 409 | 410) { return Err(response_error(response).await); }

    let artifact = upload_model_artifact(client, root, model).await?;
    if let Some(object) = payload.as_object_mut() {
        object.remove("sourceJob");
        object.insert("modelArtifact".into(), serde_json::json!({ "id": artifact.id, "token": artifact.token }));
    }
    let response = client.post(format!("{root}{endpoint}")).json(&payload).send().await.map_err(|e| format!("Could not start the processing job after uploading the local artifact: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    response.json::<CreatedJob>().await.map_err(|e| format!("The processing service returned invalid job data: {e}"))
}

pub async fn preflight(data_urls: Vec<String>) -> Result<PreflightResult, String> {
    if data_urls.is_empty() || data_urls.len() > 3 { return Err("Choose between one and three images.".into()); }
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(130)).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("{root}/v1/preflight")).json(&serde_json::json!({ "dataUrls": data_urls })).send().await.map_err(|e| format!("Could not reach the Desk Pal image check: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    response.json::<PreflightResult>().await.map_err(|e| format!("The image check returned invalid results: {e}"))
}

pub async fn run(app: AppHandle, generation_id: String, data_urls: Vec<String>, filenames: Vec<String>, views: Vec<PreflightImage>, anatomy: InitialAnatomyProfile) {
    if let Err(error) = run_inner(&app, &generation_id, &data_urls, &filenames, &views, &anatomy).await {
        let cancelled = app.state::<crate::app_state::RuntimeState>().cancel_generation.load(Ordering::Relaxed);
        let _ = mutate(&app, |value| {
            if value.generation.id.as_deref() == Some(&generation_id) {
                value.generation.stage = if cancelled { GenerationStage::Cancelled } else { GenerationStage::Failed };
                value.generation.message = if cancelled { "Creation cancelled".into() } else { "Creation stopped".into() };
                value.generation.error = Some(error);
            }
        });
        publish(&app);
    }
}

async fn run_inner(app: &AppHandle, generation_id: &str, data_urls: &[String], filenames: &[String], views: &[PreflightImage], anatomy: &InitialAnatomyProfile) -> Result<(), String> {
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(100)).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("{root}/v1/jobs")).json(&serde_json::json!({ "dataUrls": data_urls, "filenames": filenames, "views": views, "anatomyProfile": anatomy })).send().await.map_err(|e| format!("Could not reach the Desk Pal generation service: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let created = response.json::<CreatedJob>().await.map_err(|e| format!("The generation service returned an invalid job: {e}"))?;
    mutate(app, |value| { if value.generation.id.as_deref() == Some(generation_id) { value.generation.task_id = Some(created.id.clone()); value.generation.task_token = Some(created.token.clone()); } })?;
    publish(app);

    loop {
        if app.state::<crate::app_state::RuntimeState>().cancel_generation.load(Ordering::Relaxed) {
            let _ = client.delete(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await;
            return Err("Creation cancelled.".into());
        }
        let response = client.get(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await.map_err(|e| format!("Lost connection to the generation service: {e}"))?;
        if !response.status().is_success() { return Err(response_error(response).await); }
        let job = response.json::<RemoteJob>().await.map_err(|e| format!("The generation service returned invalid progress data: {e}"))?;
        let current_stage = stage(&job.stage);
        let detected_body = job.body_type.as_deref().map(body_type);
        if let Some(base_model_url) = job.base_model_url.as_deref() {
            let target = app_data_dir(app)?.join("candidate").join(generation_id).join("base.glb");
            if !target.is_file() { download_model(&client, remote_url(&root, base_model_url), &target).await?; }
            mutate(app, |value| {
                if value.generation.id.as_deref() == Some(generation_id) {
                    value.generation.candidate_model_path = Some(target.to_string_lossy().into());
                }
            })?;
        }
        mutate(app, |value| {
            if value.generation.id.as_deref() == Some(generation_id) {
                value.generation.stage = current_stage.clone();
                value.generation.progress = job.progress.clamp(0.0, 100.0);
                value.generation.message = job.message.clone();
                value.generation.error = job.error.clone();
                if detected_body.is_some() { value.generation.body_type = detected_body.clone(); }
                if job.rig_analysis.is_some() { value.generation.rig_analysis = job.rig_analysis.clone(); }
            }
        })?;
        publish(app);
        match current_stage {
            GenerationStage::ModelReady => {
                if start_existing_rig(app, data_urls, anatomy).await?.is_some() {
                    animate_existing(app).await?;
                }
                return Ok(());
            }
            GenerationStage::NeedsCorrection => return Ok(()),
            GenerationStage::Completed => {
                let model_url = job.model_url.ok_or("The completed job did not include a model URL.")?;
                mutate(app, |value| { value.generation.stage = GenerationStage::Downloading; value.generation.progress = 96.0; value.generation.message = "Saving your animated pet…".into(); })?;
                publish(app);
                let target = app_data_dir(app)?.join("candidate").join(generation_id).join("pet.glb");
                download_model(&client, remote_url(&root, &model_url), &target).await?;
                if !Path::new(&target).is_file() { return Err("The generated model could not be saved.".into()); }
                mutate(app, |value| {
                    value.generation.stage = GenerationStage::Completed;
                    value.generation.progress = 100.0;
                    value.generation.message = "Your animated 3D pet is ready.".into();
                    value.generation.candidate_model_path = Some(target.to_string_lossy().into());
                    value.generation.error = None;
                })?;
                publish(app);
                return Ok(());
            }
            GenerationStage::Failed | GenerationStage::Cancelled => return Err(job.error.unwrap_or(job.message)),
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorrectedRig { rig_analysis: RigAnalysis }

async fn monitor_corrected_job(app: &AppHandle, generation_id: String, task_id: String, token: String, corrected: RigAnalysis) -> Result<RigAnalysis, String> {
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    mutate(app, |value| {
        value.generation.task_id = Some(task_id.clone());
        value.generation.task_token = Some(token.clone());
        value.generation.rig_analysis = Some(corrected.clone());
        value.generation.stage = GenerationStage::Rigging;
        value.generation.progress = 70.0;
        value.generation.message = "Optimizing and skinning your 3D pet in Blender…".into();
        value.generation.error = None;
    })?;
    publish(app);
    for _ in 0..240 {
        if app.state::<crate::app_state::RuntimeState>().cancel_generation.load(Ordering::Relaxed) {
            let _ = client.delete(format!("{root}/v1/jobs/{task_id}?token={token}")).send().await;
            return Err("Rigging cancelled.".into());
        }
        let response = client.get(format!("{root}/v1/jobs/{task_id}?token={token}")).send().await.map_err(|e| format!("Lost connection to the Blender rig service: {e}"))?;
        if !response.status().is_success() { return Err(response_error(response).await); }
        let job = response.json::<RemoteJob>().await.map_err(|e| format!("The rig service returned invalid progress data: {e}"))?;
        let current_stage = stage(&job.stage);
        mutate(app, |value| {
            value.generation.stage = current_stage.clone();
            value.generation.progress = job.progress.clamp(0.0, 100.0);
            value.generation.message = job.message.clone();
            value.generation.error = job.error.clone();
            if job.rig_analysis.is_some() { value.generation.rig_analysis = job.rig_analysis.clone(); }
        })?;
        publish(app);
        match current_stage {
            GenerationStage::RigReady | GenerationStage::Completed => {
                let model_url = job.model_url.ok_or("The Blender rig job did not include a model URL.")?;
                let target = app_data_dir(app)?.join("candidate").join(&generation_id).join("rigged.glb");
                download_model(&client, remote_url(&root, &model_url), &target).await?;
                mutate(app, |value| {
                    value.generation.stage = GenerationStage::RigReady;
                    value.generation.progress = 84.0;
                    value.generation.message = "Your rigged model is saved. Animation is a separate retryable step.".into();
                    value.generation.candidate_model_path = Some(target.to_string_lossy().into());
                    value.generation.error = None;
                })?;
                publish(app);
                return Ok(job.rig_analysis.unwrap_or(corrected));
            }
            GenerationStage::Failed | GenerationStage::Cancelled => return Err(job.error.unwrap_or(job.message)),
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
    Err("Blender rigging timed out.".into())
}

pub async fn submit_corrections(app: &AppHandle, analysis: RigAnalysis) -> Result<RigAnalysis, String> {
    let (generation_id, task_id, token) = {
        let state = app.state::<crate::app_state::RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        (value.generation.id.clone().ok_or("The local generation is missing")?, value.generation.task_id.clone().ok_or("The rigging job is missing")?, value.generation.task_token.clone().ok_or("The rigging token is missing")?)
    };
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let response = client
        .post(format!("{root}/v1/jobs/{task_id}/corrections?token={token}"))
        .json(&serde_json::json!({
            "family": analysis.family,
            "hasTail": analysis.anatomy.tails > 0,
            "hasWings": analysis.anatomy.wings > 0,
            "landmarks": analysis.landmarks,
        }))
        .send()
        .await
        .map_err(|e| format!("Could not save the rig guide: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let corrected = response.json::<CorrectedRig>().await.map(|value| value.rig_analysis).map_err(|e| format!("The rig service returned an invalid guide: {e}"))?;
    monitor_corrected_job(app, generation_id, task_id, token, corrected).await
}

pub async fn retry_existing_rig(app: &AppHandle, analysis: RigAnalysis) -> Result<RigAnalysis, String> {
    let (generation_id, model_path, source_path, source_job) = {
        let state = app.state::<crate::app_state::RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        (
            value.generation.id.clone().ok_or("The local generation is missing")?,
            value.generation.candidate_model_path.clone().ok_or("The generated 3D model is missing")?,
            value.generation.candidate_source_path.clone().ok_or("The source image is missing")?,
            value.generation.task_id.clone().zip(value.generation.task_token.clone()),
        )
    };
    let model = tokio::fs::read(&model_path).await.map_err(|e| format!("Could not read the existing 3D model: {e}"))?;
    if model.len() < 20 || model.len() > 60 * 1024 * 1024 || &model[..4] != b"glTF" { return Err("The existing GLB is invalid or too large.".into()); }
    let source = tokio::fs::read(&source_path).await.map_err(|e| format!("Could not read the source image: {e}"))?;
    if source.is_empty() || source.len() > 20 * 1024 * 1024 { return Err("The source image is invalid or too large.".into()); }
    let mime = match Path::new(&source_path).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(150)).build().map_err(|e| e.to_string())?;
    let created = create_artifact_job(&client, &root, "/v1/rig-existing", source_job, model, serde_json::json!({
        "dataUrls": [format!("data:{mime};base64,{}", STANDARD.encode(source))],
        "rigGuide": {
            "family": analysis.family,
            "hasTail": analysis.anatomy.tails > 0,
            "hasWings": analysis.anatomy.wings > 0,
            "landmarks": analysis.landmarks,
        },
    })).await?;
    monitor_corrected_job(app, generation_id, created.id, created.token, analysis).await
}

pub async fn start_existing_rig(app: &AppHandle, data_urls: &[String], anatomy: &InitialAnatomyProfile) -> Result<Option<RigAnalysis>, String> {
    let (generation_id, model_path, source_job) = {
        let state = app.state::<crate::app_state::RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        (
            value.generation.id.clone().ok_or("The local generation is missing")?,
            value.generation.candidate_model_path.clone().ok_or("The saved base model is missing")?,
            value.generation.task_id.clone().zip(value.generation.task_token.clone()),
        )
    };
    let model = tokio::fs::read(&model_path).await.map_err(|e| format!("Could not read the saved base model: {e}"))?;
    if model.len() < 20 || model.len() > 60 * 1024 * 1024 || &model[..4] != b"glTF" { return Err("The saved base GLB is invalid or too large.".into()); }
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(150)).build().map_err(|e| e.to_string())?;
    let created = create_artifact_job(&client, &root, "/v1/rig-existing", source_job, model, serde_json::json!({
        "dataUrls": data_urls,
        "anatomyProfile": anatomy,
    })).await?;
    mutate(app, |value| {
        value.generation.task_id = Some(created.id.clone());
        value.generation.task_token = Some(created.token.clone());
        value.generation.stage = GenerationStage::Analyzing;
        value.generation.progress = 60.0;
        value.generation.message = "The model is saved. GPT and Blender are starting a separate rig job…".into();
        value.generation.error = None;
    })?;
    publish(app);
    loop {
        if app.state::<crate::app_state::RuntimeState>().cancel_generation.load(Ordering::Relaxed) {
            let _ = client.delete(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await;
            return Err("Rigging cancelled.".into());
        }
        let response = client.get(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await.map_err(|e| format!("Lost connection to the separate rig job: {e}"))?;
        if !response.status().is_success() { return Err(response_error(response).await); }
        let job = response.json::<RemoteJob>().await.map_err(|e| format!("The rig service returned invalid progress data: {e}"))?;
        let current_stage = stage(&job.stage);
        mutate(app, |value| {
            value.generation.stage = current_stage.clone();
            value.generation.progress = job.progress.clamp(0.0, 100.0);
            value.generation.message = job.message.clone();
            value.generation.error = job.error.clone();
            if job.rig_analysis.is_some() { value.generation.rig_analysis = job.rig_analysis.clone(); }
        })?;
        publish(app);
        match current_stage {
            GenerationStage::NeedsCorrection => return Ok(None),
            GenerationStage::RigReady | GenerationStage::Completed => {
                let model_url = job.model_url.ok_or("The separate rig job did not include a model URL.")?;
                let target = app_data_dir(app)?.join("candidate").join(&generation_id).join("rigged.glb");
                download_model(&client, remote_url(&root, &model_url), &target).await?;
                mutate(app, |value| {
                    value.generation.stage = GenerationStage::RigReady;
                    value.generation.progress = 84.0;
                    value.generation.message = "Your rigged model is saved. Starting animation separately…".into();
                    value.generation.candidate_model_path = Some(target.to_string_lossy().into());
                    value.generation.error = None;
                })?;
                publish(app);
                return Ok(job.rig_analysis);
            }
            GenerationStage::Failed | GenerationStage::Cancelled => return Err(job.error.unwrap_or(job.message)),
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}

pub async fn animate_existing(app: &AppHandle) -> Result<(), String> {
    let (generation_id, model_path, source_job) = {
        let state = app.state::<crate::app_state::RuntimeState>();
        let value = state.inner.lock().map_err(|_| "State unavailable")?;
        (
            value.generation.id.clone().ok_or("The local generation is missing")?,
            value.generation.candidate_model_path.clone().ok_or("The rigged model is missing")?,
            value.generation.task_id.clone().zip(value.generation.task_token.clone()),
        )
    };
    let model = tokio::fs::read(&model_path).await.map_err(|e| format!("Could not read the rigged model: {e}"))?;
    if model.len() < 20 || model.len() > 60 * 1024 * 1024 || &model[..4] != b"glTF" { return Err("The rigged GLB is invalid or too large.".into()); }
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(150)).build().map_err(|e| e.to_string())?;
    let created = create_artifact_job(&client, &root, "/v1/animate-existing", source_job, model, serde_json::json!({})).await?;
    mutate(app, |value| {
        value.generation.task_id = Some(created.id.clone());
        value.generation.task_token = Some(created.token.clone());
        value.generation.stage = GenerationStage::Animating;
        value.generation.progress = 88.0;
        value.generation.message = "Applying the reusable animation library in a separate job…".into();
        value.generation.error = None;
    })?;
    publish(app);
    loop {
        if app.state::<crate::app_state::RuntimeState>().cancel_generation.load(Ordering::Relaxed) {
            let _ = client.delete(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await;
            return Err("Animation cancelled.".into());
        }
        let response = client.get(format!("{root}/v1/jobs/{}?token={}", created.id, created.token)).send().await.map_err(|e| format!("Lost connection to the animation job: {e}"))?;
        if !response.status().is_success() { return Err(response_error(response).await); }
        let job = response.json::<RemoteJob>().await.map_err(|e| format!("The animation service returned invalid progress data: {e}"))?;
        let current_stage = stage(&job.stage);
        mutate(app, |value| {
            value.generation.stage = current_stage.clone();
            value.generation.progress = job.progress.clamp(0.0, 100.0);
            value.generation.message = job.message.clone();
            value.generation.error = job.error.clone();
        })?;
        publish(app);
        match current_stage {
            GenerationStage::Completed => {
                let model_url = job.model_url.ok_or("The animation job did not include a model URL.")?;
                let target = app_data_dir(app)?.join("candidate").join(&generation_id).join("pet.glb");
                download_model(&client, remote_url(&root, &model_url), &target).await?;
                mutate(app, |value| {
                    value.generation.stage = GenerationStage::Completed;
                    value.generation.progress = 100.0;
                    value.generation.message = "Your rigged and animated pet is ready.".into();
                    value.generation.candidate_model_path = Some(target.to_string_lossy().into());
                    value.generation.error = None;
                })?;
                publish(app);
                return Ok(());
            }
            GenerationStage::Failed | GenerationStage::Cancelled => return Err(job.error.unwrap_or(job.message)),
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}

pub(crate) fn parse_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let (header, payload) = data_url.split_once(',').ok_or("The image payload is invalid.")?;
    let ext = if header.starts_with("data:image/png") { "png" } else if header.starts_with("data:image/jpeg") { "jpg" } else if header.starts_with("data:image/webp") { "webp" } else { return Err("Only PNG, JPEG, and WebP images are accepted.".into()); };
    let bytes = STANDARD.decode(payload).map_err(|_| "The image payload is not valid base64.")?;
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 { return Err("The image must be between 1 byte and 20 MB.".into()); }
    Ok((bytes, ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn accepts_supported_data_uri() { let (bytes, ext) = parse_data_url("data:image/png;base64,aGVsbG8=").unwrap(); assert_eq!(bytes, b"hello"); assert_eq!(ext, "png"); }
    #[test] fn rejects_unknown_data_uri() { assert!(parse_data_url("data:image/gif;base64,aGVsbG8=").is_err()); }
    #[test] fn maps_manual_rigging_stage() { assert!(matches!(stage("needs_correction"), GenerationStage::NeedsCorrection)); }
    #[test] fn maps_gpt_anatomy_stage() { assert!(matches!(stage("analyzing"), GenerationStage::Analyzing)); }
    #[test] fn maps_split_pipeline_stages() {
        assert!(matches!(stage("model_ready"), GenerationStage::ModelReady));
        assert!(matches!(stage("rig_ready"), GenerationStage::RigReady));
        assert!(matches!(stage("animating"), GenerationStage::Animating));
    }
}
