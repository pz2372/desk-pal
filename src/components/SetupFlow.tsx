import { Check, ChevronLeft, ChevronRight, CircleUserRound, CreditCard, Crosshair, ImagePlus, LoaderCircle, Mail, PawPrint, RefreshCcw, RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { ChangeEvent, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppSnapshot, Personality, PetConfig, PreflightIssue, RigAnalysis, RigFamily } from "../types";
import { EMPTY_SNAPSHOT } from "../types";
import { activatePet, assetUrl, cancelGeneration, deletePet, discardPetCandidate, getSnapshot, preflightImages, selectPet, startGeneration, submitRigCorrections, useImageCandidate, useModelCandidate } from "../lib/native";
import { fileAsDataUrl, validateImage } from "../lib/validation";
import { createCorrectionGuide, firstMissingLandmark } from "../lib/rigging";
import { ModelStage } from "./ModelStage";

const personalities: { id: Personality; label: string; copy: string }[] = [
  { id: "friendly", label: "Friendly", copy: "Warm, encouraging, and delighted to see you." },
  { id: "sassy", label: "Sassy", copy: "Playful confidence with a tiny dramatic streak." },
  { id: "calm", label: "Calm", copy: "Gentle, thoughtful, and quietly reassuring." },
  { id: "chaotic", label: "Chaotic", copy: "Curious, surprising, and bursting with energy." }
];
const newPetConfig = (): PetConfig => ({ name: "", personality: "friendly", personalityNote: "", launchOnStartup: true, overlayMode: "always_on_top", chatMode: "on_click" });

export function SetupFlow() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [step, setStep] = useState(0);
  const [screen, setScreen] = useState<"onboarding" | "controls">("onboarding");
  const [controlTab, setControlTab] = useState<"pet" | "account">("pet");
  const [showDeleteWarning, setShowDeleteWarning] = useState(false);
  const [files, setFiles] = useState<(File | undefined)[]>([undefined, undefined, undefined]);
  const [imageUrls, setImageUrls] = useState<(string | undefined)[]>([undefined, undefined, undefined]);
  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[]>([]);
  const [error, setError] = useState<string>();
  const [showError, setShowError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<PetConfig>(newPetConfig());
  const [rigGuide, setRigGuide] = useState<RigAnalysis>();
  const [activeLandmark, setActiveLandmark] = useState<string>();

  useEffect(() => { getSnapshot().then((value) => {
    setSnapshot(value);
    if (value.pet) setConfig(value.pet);
    if (value.lifecycle === "ready") setScreen("controls");
  }).catch((e) => setError(String(e))); }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<string>("open-setup", async ({ payload }) => {
      setError(undefined);
      const latest = await getSnapshot();
      setSnapshot(latest);
      if (latest.pet) setConfig(latest.pet);
      if (payload === "replace") { setConfig(newPetConfig()); clearSelectedImages(); setScreen("onboarding"); setStep(1); }
      else if (payload === "welcome") { setScreen("onboarding"); setStep(0); }
      else { setScreen("controls"); setControlTab("pet"); }
    });
    return () => { stop.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (screen !== "onboarding" || step !== 2) return;
    const refresh = () => getSnapshot().then(setSnapshot).catch((e) => setError(String(e)));
    const timer = window.setInterval(refresh, 1200);
    const stop = isTauri() ? listen("generation-progress", refresh) : Promise.resolve(() => {});
    refresh();
    return () => { window.clearInterval(timer); stop.then((unlisten) => unlisten()); };
  }, [screen, step]);

  const activeError = error ?? snapshot.generation.error;
  useEffect(() => {
    if (!activeError) { setShowError(false); return; }
    setShowError(true);
    const timer = window.setTimeout(() => setShowError(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [activeError]);

  async function continueFromWelcome() {
    setBusy(true); setError(undefined);
    try { setSnapshot(await getSnapshot()); setStep(1); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function clearSelectedImages() {
    setFiles([undefined, undefined, undefined]);
    setImageUrls((current) => {
      current.forEach((url) => { if (url) URL.revokeObjectURL(url); });
      return [undefined, undefined, undefined];
    });
    setPreflightIssues([]);
  }

  async function chooseFile(index: number, event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    if (!next) return;
    const invalid = validateImage(next);
    if (invalid) return setError(invalid);
    setFiles((current) => current.map((value, slot) => slot === index ? next : value));
    setImageUrls((current) => current.map((value, slot) => {
      if (slot !== index) return value;
      if (value) URL.revokeObjectURL(value);
      return URL.createObjectURL(next);
    }));
    setPreflightIssues([]); setError(undefined);
  }

  async function generate() {
    if (!files[0]) return setError("Choose a front or three-quarter front image first.");
    setBusy(true); setError(undefined); setRigGuide(undefined); setActiveLandmark(undefined);
    try {
      const selectedFiles = files.filter((file): file is File => Boolean(file));
      const dataUrls = await Promise.all(selectedFiles.map(fileAsDataUrl));
      const preflight = await preflightImages(dataUrls);
      if (!preflight.passed) { setPreflightIssues(preflight.issues); return; }
      setPreflightIssues([]);
      await startGeneration(dataUrls, selectedFiles.map((file) => file.name), preflight.images, preflight.anatomy);
      setSnapshot(await getSnapshot());
      setStep(2);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function cancelCreation() {
    await cancelGeneration();
    setSnapshot(await getSnapshot());
  }

  async function continueWithImage() {
    setBusy(true); setError(undefined);
    try { await useImageCandidate(); setSnapshot(await getSnapshot()); setStep(3); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function previewGeneratedModel() {
    setBusy(true); setError(undefined);
    try { await useModelCandidate(); setSnapshot(await getSnapshot()); setStep(3); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function beginRigCorrection() {
    const suggested = snapshot.generation.rigAnalysis;
    const family: Exclude<RigFamily, "unsupported"> = suggested?.family === "quadruped" ? "quadruped" : "humanoid";
    const guide = createCorrectionGuide(suggested, family, Boolean(suggested?.anatomy.tails), Boolean(suggested?.anatomy.wings));
    setRigGuide(guide); setActiveLandmark(firstMissingLandmark(guide)?.name); setStep(3);
  }

  function updateRigShape(family: Exclude<RigFamily, "unsupported">, hasTail = Boolean(rigGuide?.anatomy.tails), hasWings = Boolean(rigGuide?.anatomy.wings)) {
    const guide = createCorrectionGuide(rigGuide, family, hasTail, hasWings);
    setRigGuide(guide); setActiveLandmark(firstMissingLandmark(guide)?.name);
  }

  function placeRigPoint(position: [number, number, number]) {
    if (!rigGuide || !activeLandmark) return;
    const landmarks = rigGuide.landmarks.map((landmark) => landmark.name === activeLandmark ? { ...landmark, position, confidence: 1, source: "user" as const } : landmark);
    const guide = { ...rigGuide, landmarks };
    const currentIndex = landmarks.findIndex((landmark) => landmark.name === activeLandmark);
    const next = landmarks.slice(currentIndex + 1).find((landmark) => !landmark.position) ?? landmarks.find((landmark) => !landmark.position);
    setRigGuide(guide); setActiveLandmark(next?.name);
  }

  function clearRigPoint(name: string) {
    if (!rigGuide) return;
    setRigGuide({ ...rigGuide, landmarks: rigGuide.landmarks.map((landmark) => landmark.name === name ? { ...landmark, position: undefined, confidence: 0 } : landmark) });
    setActiveLandmark(name);
  }

  async function saveRigGuide() {
    if (!rigGuide || firstMissingLandmark(rigGuide)) return setError("Choose every requested body point before continuing.");
    setBusy(true); setError(undefined);
    try { await submitRigCorrections(rigGuide); setSnapshot(await getSnapshot()); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function activate() {
    if (!config.name.trim()) return setError("Give your pet a name.");
    setBusy(true); setError(undefined);
    try { await activatePet({ ...config, name: config.name.trim(), personalityNote: config.personalityNote.trim() }); }
    catch (e) { setError(String(e)); setBusy(false); }
  }

  async function confirmDeletePet() {
    setBusy(true); setError(undefined);
    try {
      await deletePet();
      const latest = await getSnapshot();
      setShowDeleteWarning(false); setSnapshot(latest); setConfig(latest.pet ?? newPetConfig()); clearSelectedImages();
      if (latest.pets.length) { setScreen("controls"); setControlTab("pet"); } else { setScreen("onboarding"); setStep(0); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function choosePet(petId: string) {
    setBusy(true); setError(undefined);
    try { await selectPet(petId); const latest = await getSnapshot(); setSnapshot(latest); if (latest.pet) setConfig(latest.pet); setControlTab("pet"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function createNewPet() {
    setConfig(newPetConfig()); clearSelectedImages(); setError(undefined); setRigGuide(undefined); setActiveLandmark(undefined); setScreen("onboarding"); setStep(1);
  }

  async function returnToControls() {
    setBusy(true); setError(undefined);
    try {
      await discardPetCandidate();
      const latest = await getSnapshot();
      setSnapshot(latest); if (latest.pet) setConfig(latest.pet);
      clearSelectedImages(); setControlTab("pet"); setScreen("controls");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function startWindowDrag(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button === 0 && isTauri()) void getCurrentWindow().startDragging();
  }

  const missingRigPoint = firstMissingLandmark(rigGuide);
  const placedRigPoints = rigGuide?.landmarks.filter((landmark) => landmark.position).length ?? 0;

  return <main className="setup-shell">
    <div className="window-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />
    <section className="setup-card">
      <aside className="setup-aside">
        {screen === "controls" ? <><div><p className="eyebrow">PET CONTROL CENTER</p><h1>Make Desk Pal<br /><em>yours.</em></h1><p className="lede">Choose the active pet that appears on your desktop, then adjust its personality and behavior.</p></div><div className="pet-list">{snapshot.pets.map((pet) => <button key={pet.id} className={`pet-profile-button ${snapshot.selectedPetId === pet.id ? "active" : ""}`} onClick={() => choosePet(pet.id)}><span className="pet-profile-image"><img src={assetUrl(pet.asset.sourceImagePath)} alt={pet.config.name || "Pet"} /></span><span><strong>{pet.config.name || "Your pet"}</strong><small>{snapshot.selectedPetId === pet.id ? "Active pet" : pet.asset.modelPath ? "3D pet" : "Image pet"}</small></span></button>)}<button className="create-pet-button" onClick={createNewPet}><ImagePlus /> Create New Pet</button></div></> : <><div><p className="eyebrow">YOUR DESKTOP COMPANION</p><h1>Bring a character<br />to <em>life.</em></h1><p className="lede">Your images become a tiny 3D companion that lives quietly at the edge of your screen.</p></div><div className="onboarding-navigation">{snapshot.pets.length > 0 && <button className="return-controls-button" disabled={busy} onClick={returnToControls}><ChevronLeft /> Back to Pet Controls</button>}<ol className="step-list">{["Welcome", "Choose images", "Create model", "Rig & preview", "Personality"].map((label, index) => <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}><span>{index < step ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol></div></>}
        <p className="privacy-note"><ShieldCheck size={16} /> Your chat and pet stay on this computer.</p>
        {screen === "controls" && <button className={`account-nav-button ${controlTab === "account" ? "active" : ""}`} onClick={() => setControlTab("account")}><CircleUserRound /><span><strong>Account</strong></span></button>}
      </aside>
      <div className="setup-content">
        {screen === "controls" && controlTab === "pet" && <div className="panel-body controls-panel"><div className="controls-heading"><div className="panel-icon"><SlidersHorizontal /></div><div><p className="eyebrow">ACTIVE PET</p><h2>{config.name || "Pet"} controls</h2></div></div><div className="control-section"><h3>Pet profile</h3><p>Name your companion and shape how it responds.</p><label className="field-label">Pet name</label><input className="text-input" value={config.name} maxLength={28} onChange={(e) => setConfig({ ...config, name: e.target.value })} /><div className="personality-grid">{personalities.map((item) => <button key={item.id} onClick={() => setConfig({ ...config, personality: item.id })} className={config.personality === item.id ? "selected" : ""}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div><label className="field-label">Personality note <span>optional</span></label><textarea value={config.personalityNote} maxLength={240} onChange={(e) => setConfig({ ...config, personalityNote: e.target.value })} placeholder="Loves rainy days and terrible jokes…" /></div>{snapshot.asset?.characterProfile && <div className="control-section capability-section"><h3>Movement profile</h3><p>Detected as {snapshot.asset.characterProfile.skeletonFamily.replaceAll("_", " ")} · {Math.round(snapshot.asset.characterProfile.confidence * 100)}% confidence</p><div className="capability-list">{snapshot.asset.characterProfile.capabilities.filter((value) => !value.startsWith("use_")).map((value) => <span key={value}>{value.replaceAll("_", " ")}</span>)}</div></div>}<div className="control-section"><h3>Chat behavior</h3><p>Choose where conversations appear.</p><div className="chat-mode-grid"><button onClick={() => setConfig({ ...config, chatMode: "on_click" })} className={config.chatMode === "on_click" ? "selected" : ""}><strong>Click pet to chat</strong><span>Open chat from your pet.</span></button><button onClick={() => setConfig({ ...config, chatMode: "glass_widget" })} className={config.chatMode === "glass_widget" ? "selected" : ""}><strong>Glass widget</strong><span>Keep chat on the desktop.</span></button></div></div><div className="control-section"><h3>Desktop behavior</h3><div className="preference-group"><label className="switch-row"><span><strong>Show pet when my computer starts</strong><small>Launch Desk Pal automatically.</small></span><input type="checkbox" checked={config.launchOnStartup} onChange={(e) => setConfig({ ...config, launchOnStartup: e.target.checked })} /><i /></label><label className="switch-row"><span><strong>Stay above other apps</strong><small>Keep your companion visible.</small></span><input type="checkbox" checked={config.overlayMode === "always_on_top"} onChange={(e) => setConfig({ ...config, overlayMode: e.target.checked ? "always_on_top" : "normal" })} /><i /></label></div></div><div className="controls-actions"><button className="danger-button delete-pet-button" onClick={() => setShowDeleteWarning(true)}><Trash2 /> Delete pet</button><button className="primary-button" disabled={busy} onClick={activate}>{busy ? <LoaderCircle className="spin" /> : <><Check /> Save changes</>}</button></div></div>}
        {screen === "controls" && controlTab === "account" && <div className="panel-body controls-panel account-panel"><div className="controls-heading"><div className="panel-icon"><CircleUserRound /></div><div><p className="eyebrow">DESK PAL ACCOUNT</p><h2>Account</h2></div></div><div className="account-notice"><ShieldCheck /><span><strong>Local prototype</strong><small>Account services are not connected yet. Your pet and chat remain on this computer.</small></span></div><div className="account-row"><span className="account-row-icon"><Mail /></span><span><strong>Email</strong><small>Not connected</small></span><button disabled>Connect</button></div><div className="account-row"><span className="account-row-icon"><Sparkles /></span><span><strong>Plan</strong><small>Free prototype</small></span><button disabled>Manage</button></div><div className="account-row"><span className="account-row-icon"><CreditCard /></span><span><strong>Billing</strong><small>No payment method</small></span><button disabled>Manage</button></div><div className="account-section"><span className="account-row-icon"><RefreshCcw /></span><div><strong>Migrate pet</strong><p>Move your pet and preferences to another computer.</p><button className="ghost-button" disabled>Coming soon</button></div></div><div className="account-section danger"><span className="account-row-icon"><Trash2 /></span><div><strong>Delete account</strong><p>Account deletion will become available when accounts are connected.</p><button className="danger-button" disabled>Delete account</button></div></div></div>}
        {screen === "onboarding" && <>
        {step === 0 && <div className="panel-body"><div className="panel-icon"><PawPrint /></div><p className="eyebrow">STEP 1 OF 5</p><h2>Create your 3D Desk Pal</h2><p>Upload up to three character images and Desk Pal will generate, rig, and animate a desktop-ready 3D companion. You never need to enter a provider API key.</p><div className="service-note"><ShieldCheck size={18} /><span><strong>Your images are used only for pet creation</strong><small>They are sent securely to the Desk Pal generation service for GPT quality checking and 3D creation; the finished pet and chat stay local.</small></span></div><button className="primary-button" onClick={continueFromWelcome} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <>Continue <ChevronRight /></>}</button></div>}
        {step === 1 && <div className="panel-body upload-panel"><div className="panel-icon"><ImagePlus /></div><p className="eyebrow">STEP 2 OF 5</p><h2>Choose your character</h2><p>Upload one to three clear, uncropped full-body images. GPT checks them before paid 3D creation begins.</p><section className="image-guidelines" aria-labelledby="image-guidelines-title"><strong id="image-guidelines-title">Ideal images</strong><ul><li><Check />Front or three-quarter front view</li><li><Check />Side view</li><li><Check />Back or opposite three-quarter view</li></ul><p>All images should show the same character with the same clothing, colors, and proportions.</p></section>{preflightIssues.length > 0 && <section className="preflight-warning" role="alert"><div><TriangleAlert /><span><strong>Upload better images</strong><small>Generation has not started, so no Tripo credits were used.</small></span></div><ul>{preflightIssues.map((issue, index) => <li key={`${issue.type}-${index}`}><strong>{issue.type.replaceAll("_", " ")}</strong><span>{issue.explanation}</span><small>{issue.suggestion}</small></li>)}</ul></section>}<div className="multi-image-grid">{["Main view · required", "Side view · recommended", "Back view · optional"].map((label, index) => <label key={label} className={`drop-zone ${imageUrls[index] ? "has-image" : ""}`}><b>{label}</b>{imageUrls[index] ? <img src={imageUrls[index]} alt={`${label} of selected character`} /> : <><ImagePlus /><strong>{index === 0 ? "Choose main image" : "Add another angle"}</strong><span>PNG, JPG or WebP</span></>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseFile(index, event)} /></label>)}</div><div className="button-row"><button className="ghost-button" onClick={() => setStep(0)}><ChevronLeft /> Back</button><button className="primary-button" disabled={!files[0] || busy} onClick={generate}>{busy ? <><LoaderCircle className="spin" /> Checking images…</> : <>Check & create 3D pet <Sparkles /></>}</button></div></div>}
        {step === 2 && <div className="panel-body progress-panel"><div className="creation-orbit"><span className="orbit-ring" /><Sparkles size={34} /></div><p className="eyebrow">STEP 3 OF 5</p><h2>{snapshot.generation.stage === "completed" ? "Your 3D pet is ready" : snapshot.generation.stage === "needs_correction" ? "A few points need your help" : snapshot.generation.stage === "failed" || snapshot.generation.stage === "cancelled" ? "Creation needs attention" : "Bringing your pet to life"}</h2><p>{snapshot.generation.message || "Preparing your character…"}</p><div className="progress-track"><span style={{ width: `${snapshot.generation.progress}%` }} /></div><div className="progress-meta"><span>{snapshot.generation.stage.replaceAll("_", " ")}</span><span>{Math.round(snapshot.generation.progress)}%</span></div>{(snapshot.generation.stage === "failed" || snapshot.generation.stage === "cancelled") && snapshot.generation.error && <p className="generation-failure-detail" role="alert">{snapshot.generation.error}</p>}{snapshot.generation.stage === "completed" ? <button className="primary-button progress-action" onClick={() => setStep(3)}>Preview pet <ChevronRight /></button> : snapshot.generation.stage === "needs_correction" ? <div className="generation-recovery"><button className="primary-button" disabled={!snapshot.generation.candidateModelPath} onClick={beginRigCorrection}><Crosshair /> Help locate body parts</button><button className="ghost-button" disabled={busy} onClick={previewGeneratedModel}>Keep as a static 3D pet</button></div> : snapshot.generation.stage === "failed" || snapshot.generation.stage === "cancelled" ? <div className="generation-recovery">{snapshot.generation.candidateModelPath && <button className="primary-button" disabled={busy} onClick={previewGeneratedModel}>Preview generated 3D model <ChevronRight /></button>}<button className={snapshot.generation.candidateModelPath ? "ghost-button" : "primary-button"} disabled={!files[0] || busy} onClick={generate}><RefreshCcw /> Try 3D again</button><button className="ghost-button" disabled={busy} onClick={continueWithImage}>Use image pet for now</button><button className="ghost-button" onClick={() => setStep(1)}><ChevronLeft /> Choose other images</button></div> : <button className="ghost-button center progress-action" onClick={cancelCreation}>Cancel creation</button>}</div>}
        {step === 3 && snapshot.generation.stage === "needs_correction" && rigGuide && <div className="rig-correction-layout"><div className="rig-model-stage"><ModelStage url={assetUrl(snapshot.generation.candidateModelPath)} interactive landmarks={rigGuide.landmarks} activeLandmark={activeLandmark} onSurfacePoint={placeRigPoint} /><span>Click the highlighted body part · drag empty space to rotate</span></div><div className="rig-correction-copy"><p className="eyebrow">GUIDED RIGGING</p><h2>Tap the parts we missed</h2><p>Choose the closest body shape, then click each requested point directly on the model.</p><div className="rig-family-grid"><button className={rigGuide.family === "humanoid" ? "selected" : ""} onClick={() => updateRigShape("humanoid")}><strong>Humanoid</strong><span>Two legs and arms</span></button><button className={rigGuide.family === "quadruped" ? "selected" : ""} onClick={() => updateRigShape("quadruped")}><strong>Quadruped</strong><span>Four-legged creature</span></button></div><div className="rig-feature-row"><label><input type="checkbox" checked={rigGuide.anatomy.tails > 0} onChange={(event) => updateRigShape(rigGuide.family as Exclude<RigFamily, "unsupported">, event.target.checked, rigGuide.anatomy.wings > 0)} /> Has a tail</label><label><input type="checkbox" checked={rigGuide.anatomy.wings > 0} onChange={(event) => updateRigShape(rigGuide.family as Exclude<RigFamily, "unsupported">, rigGuide.anatomy.tails > 0, event.target.checked)} /> Has wings</label></div><div className="rig-current-point"><Crosshair /><span><small>NEXT POINT · {placedRigPoints}/{rigGuide.landmarks.length}</small><strong>{rigGuide.landmarks.find((landmark) => landmark.name === activeLandmark)?.label ?? "All points selected"}</strong></span></div><div className="rig-landmark-list">{rigGuide.landmarks.map((landmark) => <button key={landmark.name} className={`${activeLandmark === landmark.name ? "active" : ""} ${landmark.position ? "placed" : ""}`} onClick={() => setActiveLandmark(landmark.name)}><span>{landmark.position ? <Check /> : <Crosshair />}{landmark.label}</span>{landmark.position && <i role="button" aria-label={`Clear ${landmark.label}`} onClick={(event) => { event.stopPropagation(); clearRigPoint(landmark.name); }}><RotateCcw /></i>}</button>)}</div><button className="primary-button" disabled={Boolean(missingRigPoint) || busy} onClick={saveRigGuide}>{busy ? <LoaderCircle className="spin" /> : <><Sparkles /> Build Blender rig</>}</button><button className="ghost-button center" disabled={busy} onClick={previewGeneratedModel}>Use static model instead</button></div></div>}
        {step === 3 && snapshot.generation.stage !== "needs_correction" && <div className="preview-layout"><div className="preview-stage"><ModelStage url={assetUrl(snapshot.generation.candidateModelPath)} imageUrl={assetUrl(snapshot.generation.candidateSourcePath) ?? imageUrls[0]} interactive /><span>Drag to rotate · scroll to zoom</span></div><div className="preview-copy"><p className="eyebrow">STEP 4 OF 5</p><h2>Meet your new companion</h2><p>{snapshot.generation.candidateModelPath ? snapshot.generation.bodyType === "unknown" ? "Your generated 3D pet is ready. It will stay static because this model could not be rigged." : `Your ${snapshot.generation.bodyType?.replaceAll("_", " ") ?? "animated"} pet is rigged and ready to roam.` : "You’re using the uploaded image as your pet for now."}</p><button className="primary-button" onClick={() => setStep(4)}>Looks good <ChevronRight /></button><button className="ghost-button center" onClick={() => setStep(1)}>Try other images</button></div></div>}
        {step === 4 && <div className="panel-body personality-panel"><div className="panel-icon"><Sparkles /></div><p className="eyebrow">FINAL STEP</p><h2>Give them a personality</h2><label className="field-label">Pet name</label><input className="text-input" value={config.name} maxLength={28} onChange={(e) => setConfig({ ...config, name: e.target.value })} /><div className="personality-grid">{personalities.map((item) => <button key={item.id} onClick={() => setConfig({ ...config, personality: item.id })} className={config.personality === item.id ? "selected" : ""}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div><label className="field-label">A little extra personality <span>optional</span></label><textarea value={config.personalityNote} maxLength={240} onChange={(e) => setConfig({ ...config, personalityNote: e.target.value })} placeholder="Loves rainy days and terrible jokes…" /><label className="field-label">Chat style</label><div className="chat-mode-grid"><button onClick={() => setConfig({ ...config, chatMode: "on_click" })} className={config.chatMode === "on_click" ? "selected" : ""}><strong>Click pet to chat</strong><span>The glass chat opens only when you click your pet.</span></button><button onClick={() => setConfig({ ...config, chatMode: "glass_widget" })} className={config.chatMode === "glass_widget" ? "selected" : ""}><strong>Glass widget</strong><span>Keep the clear chat panel visible in the background.</span></button></div><div className="preference-group"><label className="switch-row"><span><strong>Show pet when my computer starts</strong><small>You can change this anytime from the tray.</small></span><input type="checkbox" checked={config.launchOnStartup} onChange={(e) => setConfig({ ...config, launchOnStartup: e.target.checked })} /><i /></label><label className="switch-row"><span><strong>Stay above other apps</strong><small>Turn this off for a desktop-only companion.</small></span><input type="checkbox" checked={config.overlayMode === "always_on_top"} onChange={(e) => setConfig({ ...config, overlayMode: e.target.checked ? "always_on_top" : "normal" })} /><i /></label></div><button className="primary-button" disabled={busy} onClick={activate}>{busy ? <LoaderCircle className="spin" /> : <><PawPrint /> Activate {config.name || "pet"}</>}</button></div>}
        </>}
        {activeError && showError && <div className="error-banner" role="alert">{activeError}</div>}
      </div>
    </section>
    {showDeleteWarning && <div className="modal-backdrop" role="presentation"><section className="warning-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-pet-title"><div className="warning-icon"><Trash2 /></div><p className="eyebrow">PERMANENT ACTION</p><h2 id="delete-pet-title">Delete {config.name || "this pet"}?</h2><p>This removes this pet’s model, image, personality, and preferences from this computer. Your other pets stay unchanged. This cannot be undone.</p><div className="warning-actions"><button className="ghost-button" disabled={busy} onClick={() => setShowDeleteWarning(false)}>Cancel</button><button className="danger-button" disabled={busy} onClick={confirmDeletePet}>{busy ? <LoaderCircle className="spin" /> : <><Trash2 /> Delete pet</>}</button></div></section></div>}
  </main>;
}
