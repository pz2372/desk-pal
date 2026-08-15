import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRigAnalysis, familyForBodyType, mergeSmartRigAnalysis, validateBlenderGuide, validateRigCorrections } from "./rigging.mjs";
import { analyzeImagePreflight } from "./preflight.mjs";
import { analyzeModelAnatomy } from "./anatomy.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const TRIPO_API_KEY = process.env.TRIPO_API_KEY;
const API_ROOT = "https://api.tripo3d.ai/v2/openapi";
const DATA_ROOT = new URL("./data/jobs/", import.meta.url).pathname;
const jobs = new Map();
const rateBuckets = new Map();
const preflightBuckets = new Map();
const MAX_BODY = 85 * 1024 * 1024;
const REQUIRED_PIPELINE_CREDITS = 105;
const BLENDER_BIN = process.env.BLENDER_BIN || "blender";
const RIG_SCRIPT = new URL("./blender/rig_pet.py", import.meta.url).pathname;
const RENDER_SCRIPT = new URL("./blender/render_model_views.py", import.meta.url).pathname;
const PROJECT_SCRIPT = new URL("./blender/project_landmarks.py", import.meta.url).pathname;
const MODEL_VIEWS = ["front", "front_left", "left", "back", "right", "front_right"];

function send(response, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store", ...headers });
  response.end(body);
}

function publicJob(job) {
  return { id: job.id, stage: job.stage, progress: job.progress, message: job.message, error: job.error, analysisStep: job.analysisStep, bodyType: job.bodyType, rigAnalysis: job.rigAnalysis, baseModelUrl: job.baseModelPath ? `/v1/jobs/${job.id}/base-model?token=${job.token}` : undefined, modelUrl: job.stage === "completed" ? `/v1/jobs/${job.id}/model?token=${job.token}` : undefined };
}

function allowRequest(ip, bucket = rateBuckets, limit = 5) {
  const now = Date.now();
  const recent = (bucket.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= limit) return false;
  recent.push(now); bucket.set(ip, recent); return true;
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

function dataModel(dataUrl) {
  const match = /^data:model\/gltf-binary;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Only a base64 GLB model is accepted.");
  const data = Buffer.from(match[1], "base64");
  if (data.length < 20 || data.length > 60 * 1024 * 1024 || data.subarray(0, 4).toString() !== "glTF") throw new Error("The GLB model is invalid or larger than 60 MB.");
  return data;
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
  if (!response.ok || (value.code !== undefined && value.code !== 0)) {
    const message = value.message || value.data?.message || `Tripo request failed (${response.status}).`;
    const traceId = response.headers.get("x-tripo-trace-id");
    const error = new Error(traceId ? `${message} (reference ${traceId})` : message);
    error.status = response.status;
    error.providerCode = value.code;
    error.traceId = traceId;
    throw error;
  }
  return value.data ?? value;
}

async function requireGenerationCapacity(job) {
  const wallet = await tripo("/user/balance");
  const available = Number(wallet.balance);
  const frozen = Number(wallet.frozen || 0);
  if (Number.isFinite(available) && available < REQUIRED_PIPELINE_CREDITS) {
    console.warn("Generation blocked before upload", { jobId: job.id, available, frozen, required: REQUIRED_PIPELINE_CREDITS });
    throw new Error("Pet creation is temporarily unavailable because generation capacity is low. Please try again later.");
  }
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

function outputModelUrl(task) {
  const output = task.output || {};
  return [output.pbr_model, output.model, output.model_url, output.model_urls?.[0], output.base_model, task.model_url, task.model].find((value) => typeof value === "string" && value.startsWith("http"));
}

async function downloadGlb(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error("Could not retrieve the generated model.");
  const model = Buffer.from(await response.arrayBuffer());
  if (model.length < 20 || model.subarray(0, 4).toString() !== "glTF") throw new Error("The provider returned an invalid GLB model.");
  await writeFile(target, model);
}

async function runBlender(job, script, args, label, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    // Blender normally exits with code 0 even when a Python script raises. Make
    // script failures observable so we never mistake a missing output for success.
    const child = spawn(BLENDER_BIN, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    job.blenderProcess = child;
    let diagnostics = "";
    const collect = (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-12_000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${label} timed out.`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); job.blenderProcess = undefined; reject(new Error(`${label} could not start: ${error.message}`)); });
    child.once("exit", (code) => {
      clearTimeout(timeout); job.blenderProcess = undefined;
      if (code === 0) resolve();
      else {
        const tracebackAt = diagnostics.lastIndexOf("Traceback (most recent call last):");
        const relevant = tracebackAt >= 0 ? diagnostics.slice(tracebackAt) : diagnostics;
        const useful = relevant.trim().slice(-6_000).replaceAll("\n", " | ");
        reject(new Error(`${label} failed${useful ? `: ${useful}` : "."}`));
      }
    });
  });
}

async function runBlenderRig(job, automatic = false) {
  if (!job.baseModelPath) throw new Error("The base model is unavailable for fallback rigging.");
  const guidePath = join(job.directory, "rig-guide.json");
  const outputPath = join(job.directory, "pet.glb");
  const guide = validateBlenderGuide(job.rigAnalysis);
  await writeFile(guidePath, JSON.stringify(guide, null, 2));
  update(job, "rigging", 70, "Blender is fitting and skinning the corrected skeleton…");
  await runBlender(job, RIG_SCRIPT, [job.baseModelPath, guidePath, outputPath], "Blender rigging");
  const model = await readFile(outputPath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("Blender finished without exporting the rigged GLB. Check the Blender job diagnostics.");
    throw error;
  });
  if (model.length < 20 || model.subarray(0, 4).toString() !== "glTF") throw new Error("Blender returned an invalid GLB model.");
  job.modelPath = outputPath;
  job.rigAnalysis = { ...job.rigAnalysis, status: "corrected", confidence: 1 };
  update(job, "completed", 100, automatic ? "Your GPT-guided Blender rig is ready." : "Your corrected Blender rig is ready.");
}

async function smartRigFallback(job, images, suggestedBodyType, fallbackMessage) {
  const fallbackFamily = familyForBodyType(suggestedBodyType) || "humanoid";
  job.rigAnalysis = createRigAnalysis(fallbackFamily === "quadruped" ? "quadruped" : "biped", false);
  if (!process.env.OPENAI_API_KEY) { update(job, "needs_correction", 62, fallbackMessage); return; }
  try {
    update(job, "analyzing", 62, "GPT is finding anatomical landmarks on the finished 3D model…");
    job.analysisStep = "rendering_glb_views";
    const renderDirectory = join(job.directory, "anatomy-views");
    await mkdir(renderDirectory, { recursive: true });
    await runBlender(job, RENDER_SCRIPT, [job.baseModelPath, renderDirectory], "Blender model rendering");
    const cameraPath = join(renderDirectory, "cameras.json");
    const cameras = JSON.parse(await readFile(cameraPath, "utf8"));
    const renders = await Promise.all(MODEL_VIEWS.map(async (name) => ({ name, dataUrl: `data:image/png;base64,${(await readFile(join(renderDirectory, `${name}.png`))).toString("base64")}` })));
    job.analysisStep = "requesting_gpt_landmarks";
    const anatomy = await analyzeModelAnatomy(images.map((image) => `data:${image.mime};base64,${image.data.toString("base64")}`), renders, {
      bounds: cameras.bounds, dimensions: cameras.dimensions, meshCount: cameras.meshCount, vertexCount: cameras.vertexCount,
    });
    if (anatomy.family === "unsupported") throw new Error("GPT could not map this creature to the current humanoid or quadruped rigs.");
    const anatomyPath = join(job.directory, "anatomy-analysis.json");
    const projectionPath = join(job.directory, "projected-landmarks.json");
    await writeFile(anatomyPath, JSON.stringify(anatomy, null, 2));
    job.analysisStep = "projecting_landmarks";
    await runBlender(job, PROJECT_SCRIPT, [job.baseModelPath, anatomyPath, cameraPath, projectionPath], "Blender landmark projection");
    const projected = JSON.parse(await readFile(projectionPath, "utf8"));
    console.info("Anatomy projection complete", { jobId: job.id, family: anatomy.family, requested: projected.requestedCount, projected: projected.projectedCount, missed: projected.missed });
    job.rigAnalysis = mergeSmartRigAnalysis(anatomy, projected, fallbackFamily);
    job.analysisStep = "building_blender_rig";
    job.bodyType = job.rigAnalysis.family === "quadruped" ? "quadruped" : "biped";
    if (job.rigAnalysis.status === "corrected") {
      await runBlenderRig(job, true);
      return;
    }
    update(job, "needs_correction", 69, "GPT found the creature’s anatomy. Please place only the uncertain points.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Smart rig analysis failed", { jobId: job.id, step: job.analysisStep, error: detail });
    if (job.rigAnalysis?.status === "corrected") {
      const uncertain = [...job.rigAnalysis.landmarks].sort((left, right) => left.confidence - right.confidence)[0];
      if (uncertain) uncertain.position = undefined;
      job.rigAnalysis.status = "needs_correction";
    }
    update(job, "needs_correction", 62, "Automatic anatomy analysis needs a few corrected points.");
    job.error = `${job.analysisStep || "anatomy_analysis"}: ${detail}`;
  }
}

function multiviewFiles(uploadedViews) {
  const files = [{}, {}, {}, {}];
  const slotForAngle = { front: 0, front_three_quarter: 0, left: 1, left_three_quarter: 1, back: 2, right: 3, right_three_quarter: 3 };
  for (const view of uploadedViews) {
    const slot = slotForAngle[view.angle];
    if (slot !== undefined && !files[slot].file_token) files[slot] = { type: view.image.ext, file_token: view.fileToken };
  }
  if (!files[0].file_token) {
    const main = uploadedViews[0];
    files[0] = { type: main.image.ext, file_token: main.fileToken };
  }
  return files;
}

async function generate(job, images, filenames, classifiedViews) {
  try {
    update(job, "uploading", 3, "Checking generation capacity…");
    await requireGenerationCapacity(job);
    update(job, "uploading", 5, `Uploading ${images.length === 1 ? "your character" : "your character views"} securely…`);
    const uploadedViews = await Promise.all(images.map(async (image, index) => {
      const form = new FormData();
      form.append("file", new Blob([image.data], { type: image.mime }), filenames[index]);
      const uploaded = await tripo("/upload/sts", { method: "POST", body: form });
      const fileToken = uploaded.file_token || uploaded.image_token;
      if (!fileToken) throw new Error("Tripo returned no image token.");
      return { image, fileToken, angle: classifiedViews.find((view) => view.index === index)?.angle || (index === 0 ? "front" : "unknown") };
    }));

    update(job, "generating", 12, "Sculpting the 3D model…");
    const orderedFiles = multiviewFiles(uploadedViews);
    const usableViewCount = orderedFiles.filter((file) => file.file_token).length;
    const generationRequest = uploadedViews.length > 1 && usableViewCount > 1
      ? { type: "multiview_to_model", files: orderedFiles }
      : { type: "image_to_model", file: { type: uploadedViews[0].image.ext, file_token: uploadedViews[0].fileToken } };
    const generationId = await createTask({ ...generationRequest, model_version: "v3.1-20260211", texture: true, pbr: true, texture_quality: "standard" });
    job.providerTaskId = generationId;
    const generated = await waitTask(job, generationId, 12, 52);
    const baseModelUrl = outputModelUrl(generated);
    if (!baseModelUrl) throw new Error("3D generation completed without a downloadable model.");
    update(job, "generating", 53, "Saving your 3D model…");
    await mkdir(job.directory, { recursive: true });
    const baseModelPath = join(job.directory, "base.glb");
    await downloadGlb(baseModelUrl, baseModelPath);
    job.baseModelPath = baseModelPath;

    // With GPT configured, the completed GLB is always analyzed and rigged in
    // Blender. The provider rigging path below is retained as a no-GPT fallback.
    if (process.env.OPENAI_API_KEY) {
      await smartRigFallback(job, images, "biped", "Please help locate this character’s body parts.");
      return;
    }

    update(job, "rig_check", 54, "Checking the creature’s body and limbs…");
    let checked;
    try {
      const checkId = await createTask({ type: "animate_prerigcheck", original_model_task_id: generationId });
      checked = await waitTask(job, checkId, 54, 62);
    } catch (error) {
      job.bodyType = "biped";
      await smartRigFallback(job, images, job.bodyType, "The automatic body check needs a few corrected points.");
      return;
    }
    job.bodyType = checked.output?.rig_type || checked.rig_type || "biped";
    const riggable = Boolean(checked.output?.riggable ?? checked.riggable);
    const guidedFamily = ["biped", "humanoid"].includes(job.bodyType) ? "humanoid" : job.bodyType === "quadruped" ? "quadruped" : undefined;
    if (guidedFamily) job.rigAnalysis = createRigAnalysis(job.bodyType, riggable);
    if (!riggable) {
      if (!guidedFamily) throw new Error("Guided fallback rigging currently supports humanoids and quadrupeds. You can still use the generated static 3D model.");
      await smartRigFallback(job, images, job.bodyType, "We need a little help locating this character’s body parts.");
      return;
    }

    update(job, "rigging", 64, "Building a skeleton for movement…");
    const rigId = await createTask({ type: "animate_rig", original_model_task_id: generationId, out_format: "glb", model_version: "v2.5-20260210", rig_type: job.bodyType, spec: "tripo" });
    try {
      await waitTask(job, rigId, 64, 77);
    } catch (error) {
      if (!guidedFamily) throw error;
      job.error = error instanceof Error ? error.message : String(error);
      await smartRigFallback(job, images, job.bodyType, "The automatic rig needs a few corrected body points.");
      return;
    }

    update(job, "animating", 78, "Teaching your pet to walk and react…");
    const animationId = await createTask({ type: "animate_retarget", original_model_task_id: rigId, out_format: "glb", animations: animations(job.bodyType), bake_animation: true, export_with_geometry: true, animate_in_place: true });
    const animated = await waitTask(job, animationId, 78, 92);
    const modelUrl = outputModelUrl(animated);
    if (!modelUrl) throw new Error("Generation completed without a downloadable model.");

    update(job, "downloading", 94, "Bringing your pet home…");
    await mkdir(job.directory, { recursive: true });
    const modelPath = join(job.directory, "pet.glb");
    await downloadGlb(modelUrl, modelPath);
    job.modelPath = modelPath;
    update(job, "completed", 100, "Your pet is ready to meet you.");
  } catch (error) {
    const failedAt = job.stage;
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Generation failed", {
      jobId: job.id,
      stage: failedAt,
      providerTaskId: job.providerTaskId,
      providerCode: error?.providerCode,
      traceId: error?.traceId,
      error: detail,
    });
    job.failureStage = failedAt;
    job.stage = job.cancelled ? "cancelled" : "failed";
    job.message = job.cancelled ? "Creation cancelled" : `Creation stopped during ${failedAt.replaceAll("_", " ")}`;
    job.error = detail;
  }
}

async function handler(request, response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, release: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local", generationConfigured: Boolean(TRIPO_API_KEY), preflightConfigured: Boolean(process.env.OPENAI_API_KEY), smartRigConfigured: Boolean(process.env.OPENAI_API_KEY && BLENDER_BIN) });
  if (request.method === "POST" && url.pathname === "/v1/preflight") {
    if (!process.env.OPENAI_API_KEY) return send(response, 503, { error: "The GPT image-quality check is not configured." });
    if (!allowRequest(request.socket.remoteAddress || "unknown", preflightBuckets, 15)) return send(response, 429, { error: "Image check limit reached. Try again later." });
    try {
      const payload = await bodyJson(request);
      if (!Array.isArray(payload.dataUrls) || payload.dataUrls.length < 1 || payload.dataUrls.length > 3) throw new Error("Choose between one and three images.");
      payload.dataUrls.forEach(dataImage);
      return send(response, 200, await analyzeImagePreflight(payload.dataUrls));
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === "POST" && url.pathname === "/v1/jobs") {
    if (!TRIPO_API_KEY) return send(response, 503, { error: "Generation service is not configured." });
    if (!allowRequest(request.socket.remoteAddress || "unknown")) return send(response, 429, { error: "Creation limit reached. Try again later." });
    try {
      const payload = await bodyJson(request);
      const dataUrls = Array.isArray(payload.dataUrls) ? payload.dataUrls : [payload.dataUrl];
      if (dataUrls.length < 1 || dataUrls.length > 3) throw new Error("Choose between one and three images.");
      const images = dataUrls.map(dataImage);
      const suppliedNames = Array.isArray(payload.filenames) ? payload.filenames : [payload.filename];
      const filenames = images.map((image, index) => {
        const originalName = String(suppliedNames[index] || `character-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 90);
        return `${originalName.replace(/\.[^.]+$/, "")}.${image.ext}`;
      });
      const classifiedViews = Array.isArray(payload.views) ? payload.views : [{ index: 0, angle: "front" }];
      const id = randomUUID(); const token = randomBytes(24).toString("hex");
      const job = { id, token, stage: "uploading", progress: 2, message: "Preparing your images…", createdAt: Date.now(), directory: join(DATA_ROOT, id), cancelled: false };
      jobs.set(id, job); generate(job, images, filenames, classifiedViews);
      return send(response, 202, { id, token });
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === "POST" && url.pathname === "/v1/rig-existing") {
    if (!process.env.OPENAI_API_KEY) return send(response, 503, { error: "Smart rigging is not configured." });
    if (!allowRequest(request.socket.remoteAddress || "unknown")) return send(response, 429, { error: "Rigging limit reached. Try again later." });
    try {
      const payload = await bodyJson(request);
      const dataUrls = Array.isArray(payload.dataUrls) ? payload.dataUrls : [payload.dataUrl];
      if (dataUrls.length < 1 || dataUrls.length > 3) throw new Error("Choose between one and three reference images.");
      const images = dataUrls.map(dataImage);
      const model = dataModel(payload.modelDataUrl);
      const id = randomUUID(); const token = randomBytes(24).toString("hex");
      const directory = join(DATA_ROOT, id); const baseModelPath = join(directory, "base.glb");
      await mkdir(directory, { recursive: true }); await writeFile(baseModelPath, model);
      const job = { id, token, stage: "analyzing", progress: 60, message: "Preparing the existing model for smart rigging…", createdAt: Date.now(), directory, baseModelPath, cancelled: false };
      jobs.set(id, job); smartRigFallback(job, images, "biped", "Please help locate this character’s body parts.");
      return send(response, 202, { id, token });
    } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  const match = /^\/v1\/jobs\/([0-9a-f-]+)(?:\/(model|base-model|corrections))?$/.exec(url.pathname);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job || url.searchParams.get("token") !== job.token) return send(response, 404, { error: "Job not found." });
    if (request.method === "DELETE") { job.cancelled = true; job.blenderProcess?.kill("SIGKILL"); return send(response, 202, { cancelled: true }); }
    if (request.method === "POST" && match[2] === "corrections") {
      try {
        const corrected = validateRigCorrections(await bodyJson(request));
        job.rigAnalysis = corrected;
        job.bodyType = corrected.family === "quadruped" ? "quadruped" : "biped";
        await mkdir(job.directory, { recursive: true });
        await writeFile(join(job.directory, "rig-guide.json"), JSON.stringify(corrected, null, 2));
        runBlenderRig(job).catch((error) => {
          job.stage = job.cancelled ? "cancelled" : "failed";
          job.message = job.cancelled ? "Rigging cancelled" : "Blender could not finish this rig";
          job.error = error instanceof Error ? error.message : String(error);
          console.error("Fallback rigging failed", { jobId: job.id, error: job.error });
        });
        return send(response, 200, { rigAnalysis: corrected });
      } catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (request.method === "GET" && (match[2] === "model" || match[2] === "base-model")) {
      const modelPath = match[2] === "base-model" ? job.baseModelPath : job.modelPath;
      if (!modelPath || (match[2] === "model" && job.stage !== "completed")) return send(response, 409, { error: "Model is not ready." });
      const model = await readFile(modelPath); response.writeHead(200, { "content-type": "model/gltf-binary", "content-length": model.length, "cache-control": "private, no-store" }); return response.end(model);
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
