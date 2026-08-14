use base64::{engine::general_purpose::STANDARD, Engine};
use crate::{app_state::{app_data_dir, mutate}, models::{BodyType, GenerationStage}};
use serde::Deserialize;
use std::{path::Path, sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

fn server_root() -> String {
    std::env::var("DESK_PAL_SERVER_URL")
        .ok()
        .or_else(|| option_env!("DESK_PAL_SERVER_URL").map(str::to_string))
        .or_else(|| option_env!("NOCTURNE_SERVER_URL").map(str::to_string))
        .unwrap_or_else(|| "http://127.0.0.1:8787".into())
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
    model_url: Option<String>,
}

#[derive(Deserialize)]
struct ErrorResponse { error: Option<String> }

fn stage(value: &str) -> GenerationStage {
    match value { "uploading" => GenerationStage::Uploading, "generating" => GenerationStage::Generating, "rig_check" => GenerationStage::RigCheck, "rigging" => GenerationStage::Rigging, "animating" => GenerationStage::Animating, "downloading" => GenerationStage::Downloading, "completed" => GenerationStage::Completed, "cancelled" => GenerationStage::Cancelled, _ => GenerationStage::Failed }
}

fn body_type(value: &str) -> BodyType {
    match value { "biped" | "humanoid" => BodyType::Biped, "quadruped" => BodyType::Quadruped, "hexapod" => BodyType::Hexapod, "octopod" => BodyType::Octopod, "avian" | "bird" => BodyType::Avian, "serpentine" => BodyType::Serpentine, "aquatic" => BodyType::Aquatic, _ => BodyType::Unknown }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    response.json::<ErrorResponse>().await.ok().and_then(|v| v.error).unwrap_or_else(|| format!("Generation service returned {status}."))
}

fn publish(app: &AppHandle) { let _ = app.emit("generation-progress", ()); }

pub async fn run(app: AppHandle, generation_id: String, data_url: String, filename: String) {
    if let Err(error) = run_inner(&app, &generation_id, &data_url, &filename).await {
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

async fn run_inner(app: &AppHandle, generation_id: &str, data_url: &str, filename: &str) -> Result<(), String> {
    let root = server_root();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(100)).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("{root}/v1/jobs")).json(&serde_json::json!({ "dataUrl": data_url, "filename": filename })).send().await.map_err(|e| format!("Could not reach the Desk Pal generation service: {e}"))?;
    if !response.status().is_success() { return Err(response_error(response).await); }
    let created = response.json::<CreatedJob>().await.map_err(|e| format!("The generation service returned an invalid job: {e}"))?;
    mutate(app, |value| { if value.generation.id.as_deref() == Some(generation_id) { value.generation.task_id = Some(created.id.clone()); } })?;
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
        mutate(app, |value| {
            if value.generation.id.as_deref() == Some(generation_id) {
                value.generation.stage = current_stage.clone();
                value.generation.progress = job.progress.clamp(0.0, 100.0);
                value.generation.message = job.message.clone();
                value.generation.error = job.error.clone();
                if detected_body.is_some() { value.generation.body_type = detected_body.clone(); }
            }
        })?;
        publish(app);
        match current_stage {
            GenerationStage::Completed => {
                let model_url = job.model_url.ok_or("The completed job did not include a model URL.")?;
                let download_url = if model_url.starts_with("http://") || model_url.starts_with("https://") { model_url } else { format!("{root}{model_url}") };
                mutate(app, |value| { value.generation.stage = GenerationStage::Downloading; value.generation.progress = 96.0; value.generation.message = "Saving your animated pet…".into(); })?;
                publish(app);
                let response = client.get(download_url).send().await.map_err(|e| format!("Could not download the generated model: {e}"))?;
                if !response.status().is_success() { return Err(response_error(response).await); }
                let bytes = response.bytes().await.map_err(|e| e.to_string())?;
                if bytes.len() < 20 || &bytes[..4] != b"glTF" { return Err("The generation service returned an invalid GLB model.".into()); }
                let target = app_data_dir(app)?.join("candidate").join(generation_id).join("pet.glb");
                if let Some(parent) = target.parent() { tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?; }
                tokio::fs::write(&target, &bytes).await.map_err(|e| e.to_string())?;
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
}
