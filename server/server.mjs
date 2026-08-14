import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { extname, join } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
const API_ROOT = "https://api.tripo3d.ai/v2/openapi";
const DATA_ROOT = new URL("./data/jobs/", import.meta.url).pathname;
const jobs = new Map();
const rateBuckets = new Map();
const MAX_BODY = 28 * 1024 * 1024;

function send(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store", ...headers });
  response.end(body);
}

function publicJob(job) {
  return { id: job.id, stage: job.stage, progress: job.progress, message: job.message, error: job.error, bodyType: job.bodyType, modelUrl: job.stage === "completed" ? `/v1/jobs/${job.id}/model?token=${job.token}` : undefined };
}

function allowRequest(ip) {
  const now = Date.now();
  const recent = (rateBuckets.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now); rateBuckets.set(ip, recent); return true;
}

async function bodyJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Upload exceeds 20 MB after encoding.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dataImage(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Only PNG, JPEG, and WebP data URLs are accepted.");
  const data = Buffer.from(match[2], "base64");
  if (!data.length || data.length > 20 * 1024 * 1024) throw new Error("Image must be 20 MB or smaller.");
  const ext = match[1] === "image/jpeg" ? "jpg" : match[1].split("/")[1];
  return { data, mime: match[1], ext };
}

async function tripo(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, { ...options, headers: { authorization: `Bearer ${TRIPO_API_KEY}`, ...options.headers }, signal: AbortSignal.timeout(90_000) });
  } catch (error) {
    const detail = error?.cause?.message || error?.message || String(error);
    throw new Error(`Could not reach Tripo: ${detail}`);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok || (value.code !== undefined && value.code !== 0)) throw new Error(value.message || value.data?.message || `Tripo request failed (${response.status}).`);
  return value.data ?? value;
}

async function createTask(body) {
  const data = await tripo("/task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!data.task_id) throw new Error("Tripo returned no task ID.");
  return data.task_id;
}

async function waitTask(job, id, floor, ceiling) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (job.cancelled) throw new Error("Creation cancelled.");
    const data = await tripo(`/task/${id}`);
    const status = String(data.status || "").toLowerCase();
    job.progress = floor + (ceiling - floor) * Math.max(0, Math.min(1, Number(data.progress || 0) / 100));
    if (["success", "succeeded", "completed"].includes(status)) return data;
    if (["failed", "cancelled", "banned", "expired"].includes(status)) throw new Error(data.task_error?.message || data.error || "The provider could not complete this step.");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Generation timed out.");
}

function update(job, stage, progress, message) { Object.assign(job, { stage, progress, message, error: undefined }); }

function animations(bodyType) {
  const walks = { quadruped: "preset:quadruped:walk", hexapod: "preset:hexapod:walk", octopod: "preset:octopod:walk", serpentine: "preset:serpentine:march", aquatic: "preset:aquatic:march" };
  return ["preset:idle", walks[bodyType] || "preset:walk", "preset:turn", "preset:jump", "preset:hurt"];
}

async function generate(job, image, filename) {
  try {
    update(job, "uploading", 5, "Uploading your character securely…");
    const form = new FormData(); form.append("file", new Blob([image.data], { type: image.mime }), filename);
    const uploaded = await tripo("/upload/sts", { method: "POST", body: form });
    const fileToken = uploaded.file_token || uploaded.image_token;
    if (!fileToken) throw new Error("Tripo returned no image token.");

    update(job, "generating", 12, "Sculpting the 3D model…");
    const generationId = await createTask({ type: "image_to_model", file: { type: image.ext, file_token: fileToken }, model_version: "v3.1-20260211", texture: true, pbr: true, texture_quality: "standard" });
    job.providerTaskId = generationId;
    await waitTask(job, generationId, 12, 52);

    update(job, "rig_check", 54, "Checking the creature’s body and limbs…");
    const checkId = await createTask({ type: "animate_prerigcheck", original_model_task_id: generationId });
    const checked = await waitTask(job, checkId, 54, 62);
    if (!(checked.output?.riggable ?? checked.riggable)) throw new Error("This character could not be rigged. Try a clear, uncropped full-body image with separated limbs.");
    job.bodyType = checked.output?.rig_type || checked.rig_type || "biped";

    update(job, "rigging", 64, "Building a skeleton for movement…");
    const rigId = await createTask({ type: "animate_rig", original_model_task_id: generationId, out_format: "glb", model_version: "v2.5-20260210", rig_type: job.bodyType, spec: "tripo" });
    await waitTask(job, rigId, 64, 77);

    update(job, "animating", 78, "Teaching your pet to walk and react…");
    const animationId = await createTask({ type: "animate_retarget", original_model_task_id: rigId, out_format: "glb", animations: animations(job.bodyType), bake_animation: true, export_with_geometry: true, animate_in_place: true });
    const animated = await waitTask(job, animationId, 78, 92);
    const modelUrl = animated.output?.model_url || animated.output?.model_urls?.[0] || animated.output?.model || animated.output?.pbr_model || animated.output?.base_model || animated.model_url || animated.model;
    if (!modelUrl) throw new Error("Generation completed without a downloadable model.");

    update(job, "downloading", 94, "Bringing your pet home…");
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error("Could not retrieve the finished model.");
    const model = Buffer.from(await response.arrayBuffer());
    if (model.length < 20 || model.subarray(0, 4).toString() !== "glTF") throw new Error("The provider returned an invalid GLB model.");
    await mkdir(job.directory, { recursive: true });
    job.modelPath = join(job.directory, "pet.glb"); await writeFile(job.modelPath, model);
    update(job, "completed", 100, "Your pet is ready to meet you.");
  } catch (error) {
    job.stage = job.cancelled ? "cancelled" : "failed"; job.message = job.cancelled ? "Creation cancelled" : "Creation stopped"; job.error = error instanceof Error ? error.message : String(error);
  }
}

async function handler(request, response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, generationConfigured: Boolean(TRIPO_API_KEY) });
  if (request.method === "POST" && url.pathname === "/v1/jobs") {
    if (!TRIPO_API_KEY) return send(response, 503, { error: "Generation service is not configured." });
    if (!allowRequest(request.socket.remoteAddress || "unknown")) return send(response, 429, { error: "Creation limit reached. Try again later." });
    try {
      const payload = await bodyJson(request); const image = dataImage(payload.dataUrl);
      const originalName = String(payload.filename || "character").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 90);
      const filename = `${originalName.replace(/\.[^.]+$/, "")}.${image.ext}`;
      const id = randomUUID(); const token = randomBytes(24).toString("hex");
      const job = { id, token, stage: "uploading", progress: 2, message: "Preparing your image…", createdAt: Date.now(), directory: join(DATA_ROOT, id), cancelled: false };
      jobs.set(id, job); generate(job, image, filename);
      return send(response, 202, { id, token });
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  const match = /^\/v1\/jobs\/([0-9a-f-]+)(?:\/(model))?$/.exec(url.pathname);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job || url.searchParams.get("token") !== job.token) return send(response, 404, { error: "Job not found." });
    if (request.method === "DELETE") { job.cancelled = true; return send(response, 202, { cancelled: true }); }
    if (request.method === "GET" && match[2] === "model") {
      if (job.stage !== "completed" || !job.modelPath) return send(response, 409, { error: "Model is not ready." });
      const model = await readFile(job.modelPath); response.writeHead(200, { "content-type": "model/gltf-binary", "content-length": model.length, "cache-control": "private, no-store" }); return response.end(model);
    }
    if (request.method === "GET") return send(response, 200, publicJob(job));
  }
  send(response, 404, { error: "Not found." });
}

await mkdir(DATA_ROOT, { recursive: true });
setInterval(async () => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) { jobs.delete(id); await rm(job.directory, { recursive: true, force: true }); }
}, 60 * 60 * 1000).unref();

createServer((request, response) => handler(request, response).catch((error) => send(response, 500, { error: String(error) }))).listen(PORT, HOST, () => {
  console.log(`Desk Pal generation server listening on http://${HOST}:${PORT}`);
  if (!TRIPO_API_KEY) console.warn("TRIPO_API_KEY is not set; generation requests will return 503.");
});
