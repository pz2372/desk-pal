use crate::{app_state::{model_path, mutate, RuntimeState}, models::{ChatTurn, LocalAiReply, Personality}};
use futures_util::StreamExt;
use rand::{distributions::Alphanumeric, Rng};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{fs, io::AsyncWriteExt, process::Command, time::sleep};

const MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf";
const MODEL_SHA256: &str = "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031";

pub async fn install_model(app: AppHandle) {
    let result = install_model_inner(&app).await;
    if let Err(error) = result {
        let _ = mutate(&app, |s| { s.model_download.downloading = false; s.model_download.error = Some(error); });
    }
}

async fn install_model_inner(app: &AppHandle) -> Result<(), String> {
    let destination = model_path(app)?;
    if destination.is_file() { return Ok(()); }
    if let Some(parent) = destination.parent() { fs::create_dir_all(parent).await.map_err(|e| e.to_string())?; }
    mutate(app, |s| { s.model_download.downloading = true; s.model_download.progress = 0.0; s.model_download.error = None; })?;
    let response = reqwest::get(MODEL_URL).await.map_err(|e| format!("Local AI download failed: {e}"))?.error_for_status().map_err(|e| e.to_string())?;
    let total = response.content_length().unwrap_or(0);
    let temp = destination.with_extension("gguf.download");
    let mut output = fs::File::create(&temp).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    let mut hash = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        hash.update(&chunk);
        output.write_all(&chunk).await.map_err(|e| e.to_string())?;
        let progress = if total > 0 { received as f32 / total as f32 * 100.0 } else { 0.0 };
        let _ = mutate(app, |s| s.model_download.progress = progress);
        let _ = app.emit("model-download-progress", progress);
    }
    output.flush().await.map_err(|e| e.to_string())?;
    let actual = format!("{:x}", hash.finalize());
    if actual != MODEL_SHA256 { let _ = fs::remove_file(&temp).await; return Err("The local AI model failed its security checksum and was removed.".into()); }
    fs::rename(temp, destination).await.map_err(|e| e.to_string())?;
    mutate(app, |s| { s.model_download.downloading = false; s.model_download.progress = 100.0; })
}

fn fallback(message: &str, name: &str, personality: &Personality) -> LocalAiReply {
    let lower = message.to_ascii_lowercase();
    let (reply, emotion, action) = if lower.contains("hello") || lower.contains("hi") {
        (format!("Hi! {name} is very glad you stopped by."), "happy", "jump")
    } else if lower.contains('?') {
        ("That’s interesting. I’m still thinking about it with my tiny pet brain.".into(), "curious", "turn")
    } else {
        match personality {
            Personality::Sassy => ("Noted. I’ll pretend I wasn’t already thinking that.".into(), "annoyed", "react"),
            Personality::Calm => ("I’m here with you. We can take it one small step at a time.".into(), "calm", "idle"),
            Personality::Chaotic => ("Excellent. This clearly calls for one completely unnecessary victory hop!".into(), "surprised", "jump"),
            Personality::Friendly => ("I’m happy you told me. Want to hang out for a while?".into(), "happy", "react"),
        }
    };
    LocalAiReply { reply, emotion: emotion.into(), action: action.into(), local_model: false }
}

fn executable(app: &AppHandle) -> PathBuf {
    if let Ok(path) = std::env::var("NOCTURNE_LLAMA_SERVER") { return PathBuf::from(path); }
    let filename = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    app.path().resource_dir().ok().map(|p| p.join("bin").join(filename)).filter(|p| p.is_file()).unwrap_or_else(|| PathBuf::from(filename))
}

async fn ensure_server(app: &AppHandle) -> Result<(String, String), String> {
    let state = app.state::<RuntimeState>();
    let mut runtime = state.ai.lock().await;
    if let (Some(endpoint), Some(token)) = (&runtime.endpoint, &runtime.token) { return Ok((endpoint.clone(), token.clone())); }
    let model = model_path(app)?;
    if !model.is_file() { return Err("The optional local model is not installed.".into()); }
    let port = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?.local_addr().map_err(|e| e.to_string())?.port();
    let token: String = rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect();
    let endpoint = format!("http://127.0.0.1:{port}");
    let child = Command::new(executable(app)).args(["--model", model.to_string_lossy().as_ref(), "--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &token, "--ctx-size", "4096", "--threads", "4"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_| "The llama.cpp runtime is not packaged for this computer yet.".to_string())?;
    runtime.child = Some(child); runtime.endpoint = Some(endpoint.clone()); runtime.token = Some(token.clone());
    drop(runtime);
    for _ in 0..50 {
        if reqwest::get(format!("{endpoint}/health")).await.map(|r| r.status().is_success()).unwrap_or(false) { return Ok((endpoint, token)); }
        sleep(Duration::from_millis(200)).await;
    }
    Err("The local AI runtime did not become ready.".into())
}

fn parse_reply(raw: &str) -> Option<LocalAiReply> {
    let start = raw.find('{')?; let end = raw.rfind('}')?;
    let value: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let reply = value.get("reply")?.as_str()?.trim();
    let emotion = value.get("emotion")?.as_str()?;
    let action = value.get("action")?.as_str()?;
    if reply.is_empty() || reply.len() > 500 || !["happy", "curious", "calm", "sleepy", "surprised", "annoyed"].contains(&emotion) || !["idle", "walk", "turn", "jump", "react"].contains(&action) { return None; }
    Some(LocalAiReply { reply: reply.into(), emotion: emotion.into(), action: action.into(), local_model: true })
}

pub async fn chat(app: &AppHandle, message: String, pet_id: Option<String>) -> Result<LocalAiReply, String> {
    let clean = message.trim();
    if clean.is_empty() || clean.chars().count() > 300 { return Err("Messages must contain 1–300 characters.".into()); }
    let (pet, capabilities, history, summary) = {
        let state = app.state::<RuntimeState>();
        let guard = state.inner.lock().map_err(|_| "State unavailable")?;
        let record = pet_id.as_ref().and_then(|id| guard.pets.iter().find(|pet| &pet.id == id));
        let pet = record.map(|pet| pet.config.clone()).or_else(|| guard.pet.clone()).ok_or("No active pet")?;
        let capabilities = record.map(|pet| pet.asset.character_profile.capabilities.clone()).or_else(|| guard.asset.as_ref().map(|asset| asset.character_profile.capabilities.clone())).unwrap_or_default();
        (pet, capabilities, guard.conversation.iter().rev().take(12).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(), guard.conversation_summary.clone())
    };
    let mut allowed_actions = vec!["idle"];
    if capabilities.iter().any(|value| value == "walk" || value == "fly" || value == "swim") { allowed_actions.push("walk"); }
    if capabilities.iter().any(|value| value == "look_around" || value == "walk") { allowed_actions.push("turn"); }
    if capabilities.iter().any(|value| value == "jump") { allowed_actions.push("jump"); }
    if capabilities.iter().any(|value| ["happy", "sad", "wave", "dance", "play", "use_arms", "use_tail", "use_wings"].contains(&value.as_str())) { allowed_actions.push("react"); }
    let local: Result<LocalAiReply, String> = async {
        let (endpoint, token) = ensure_server(app).await?;
        let style = format!("{:?}", pet.personality).to_ascii_lowercase();
        let system = format!("/no_think You are {}, a tiny {} desktop pet. {} Be warm, safe, playful, and concise (1-2 sentences). Return ONLY JSON with reply, emotion, action. emotion must be happy|curious|calm|sleepy|surprised|annoyed. Choose action only from: {}. Physical capabilities: {}. Earlier memory: {}", pet.name, style, pet.personality_note, allowed_actions.join("|"), capabilities.join(", "), summary);
        let mut messages = vec![json!({"role":"system", "content":system})];
        messages.extend(history.iter().map(|turn| json!({"role":turn.role, "content":turn.content})));
        messages.push(json!({"role":"user", "content":clean}));
        let response: Value = reqwest::Client::new().post(format!("{endpoint}/v1/chat/completions")).bearer_auth(token).json(&json!({"model":"Qwen3-0.6B", "messages":messages, "temperature":0.7, "top_p":0.8, "max_tokens":180, "response_format":{"type":"json_object"}})).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let content = response.pointer("/choices/0/message/content").and_then(Value::as_str).ok_or_else(|| "Local AI returned no reply".to_string())?;
        parse_reply(content).ok_or_else(|| "Local AI returned an invalid reply".to_string())
    }.await;
    let mut reply = local.unwrap_or_else(|_| fallback(clean, &pet.name, &pet.personality));
    if !allowed_actions.contains(&reply.action.as_str()) {
        reply.action = if allowed_actions.contains(&"react") { "react".into() } else { "idle".into() };
    }
    mutate(app, |state| {
        state.conversation.push(ChatTurn { role: "user".into(), content: clean.into() });
        state.conversation.push(ChatTurn { role: "assistant".into(), content: reply.reply.clone() });
        while state.conversation.len() > 12 {
            let old = state.conversation.remove(0);
            if state.conversation_summary.len() < 1200 { state.conversation_summary.push_str(&format!(" {}: {};", old.role, old.content)); }
        }
    })?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_structured_reply() {
        let parsed = parse_reply(r#"prefix {"reply":"Hello!","emotion":"happy","action":"jump"} suffix"#).unwrap();
        assert_eq!(parsed.emotion, "happy"); assert!(parsed.local_model);
    }

    #[test]
    fn rejects_unknown_motion() {
        assert!(parse_reply(r#"{"reply":"Hello!","emotion":"happy","action":"explode"}"#).is_none());
    }
}
