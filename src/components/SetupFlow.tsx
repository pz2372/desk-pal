import { Check, ChevronLeft, ChevronRight, CircleUserRound, CreditCard, ImagePlus, LoaderCircle, Mail, PawPrint, RefreshCcw, ShieldCheck, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { ChangeEvent, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppSnapshot, Personality, PetConfig } from "../types";
import { EMPTY_SNAPSHOT } from "../types";
import { activatePet, assetUrl, cancelGeneration, deletePet, discardPetCandidate, getSnapshot, startGeneration, useImageCandidate } from "../lib/native";
import { fileAsDataUrl, validateImage } from "../lib/validation";
import { ModelStage } from "./ModelStage";

const personalities: { id: Personality; label: string; copy: string }[] = [
  { id: "friendly", label: "Friendly", copy: "Warm, encouraging, and delighted to see you." },
  { id: "sassy", label: "Sassy", copy: "Playful confidence with a tiny dramatic streak." },
  { id: "calm", label: "Calm", copy: "Gentle, thoughtful, and quietly reassuring." },
  { id: "chaotic", label: "Chaotic", copy: "Curious, surprising, and bursting with energy." }
];

export function SetupFlow() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [step, setStep] = useState(0);
  const [screen, setScreen] = useState<"onboarding" | "controls">("onboarding");
  const [controlTab, setControlTab] = useState<"pet" | "account">("pet");
  const [showDeleteWarning, setShowDeleteWarning] = useState(false);
  const [file, setFile] = useState<File>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [showError, setShowError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<PetConfig>({ name: "", personality: "friendly", personalityNote: "", launchOnStartup: true, overlayMode: "always_on_top", chatMode: "on_click" });

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
      if (payload === "replace") { setScreen("onboarding"); setStep(1); }
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

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    if (!next) return;
    const invalid = validateImage(next);
    if (invalid) return setError(invalid);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setFile(next); setImageUrl(URL.createObjectURL(next)); setError(undefined);
  }

  async function generate() {
    if (!file) return setError("Choose an image first.");
    setBusy(true); setError(undefined);
    try {
      await startGeneration(await fileAsDataUrl(file), file.name);
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
      setShowDeleteWarning(false); setSnapshot(EMPTY_SNAPSHOT); setConfig({ name: "", personality: "friendly", personalityNote: "", launchOnStartup: true, overlayMode: "always_on_top", chatMode: "on_click" }); setFile(undefined); setImageUrl(undefined); setScreen("onboarding"); setStep(0);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function returnToControls() {
    setBusy(true); setError(undefined);
    try {
      await discardPetCandidate();
      const latest = await getSnapshot();
      setSnapshot(latest); if (latest.pet) setConfig(latest.pet);
      setFile(undefined); setImageUrl(undefined); setControlTab("pet"); setScreen("controls");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function startWindowDrag(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button === 0 && isTauri()) void getCurrentWindow().startDragging();
  }

  return <main className="setup-shell">
    <div className="window-drag-region" data-tauri-drag-region onMouseDown={startWindowDrag} />
    <section className="setup-card">
      <aside className="setup-aside">
        {screen === "controls" ? <><div><p className="eyebrow">PET CONTROL CENTER</p><h1>Make Desk Pal<br /><em>yours.</em></h1><p className="lede">Adjust how your companion behaves, chats, and appears on your desktop.</p></div><div className="pet-list"><button className={`pet-profile-button ${controlTab === "pet" ? "active" : ""}`} onClick={() => setControlTab("pet")}><span className="pet-profile-image">{snapshot.asset?.sourceImagePath ? <img src={assetUrl(snapshot.asset.sourceImagePath)} alt={config.name || "Pet"} /> : <PawPrint />}</span><span><strong>{config.name || "Your pet"}</strong><small>Pet controls</small></span></button><button className="create-pet-button" onClick={() => { setScreen("onboarding"); setStep(1); }}><ImagePlus /> Create New Pet</button></div></> : <><div><p className="eyebrow">YOUR DESKTOP COMPANION</p><h1>Bring a character<br />to <em>life.</em></h1><p className="lede">One image becomes a tiny 3D companion that lives quietly at the edge of your screen.</p></div><div className="onboarding-navigation">{snapshot.asset && <button className="return-controls-button" disabled={busy} onClick={returnToControls}><ChevronLeft /> Back to Pet Controls</button>}<ol className="step-list">{["Welcome", "Choose image", "Create model", "Preview", "Personality"].map((label, index) => <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}><span>{index < step ? <Check size={13} /> : index + 1}</span>{label}</li>)}</ol></div></>}
        <p className="privacy-note"><ShieldCheck size={16} /> Your chat and pet stay on this computer.</p>
        {screen === "controls" && <button className={`account-nav-button ${controlTab === "account" ? "active" : ""}`} onClick={() => setControlTab("account")}><CircleUserRound /><span><strong>Account</strong></span></button>}
      </aside>
      <div className="setup-content">
        {screen === "controls" && controlTab === "pet" && <div className="panel-body controls-panel"><div className="controls-heading"><div className="panel-icon"><SlidersHorizontal /></div><div><p className="eyebrow">ACTIVE PET</p><h2>{config.name || "Pet"} controls</h2></div></div><div className="control-section"><h3>Pet profile</h3><p>Name your companion and shape how it responds.</p><label className="field-label">Pet name</label><input className="text-input" value={config.name} maxLength={28} onChange={(e) => setConfig({ ...config, name: e.target.value })} /><div className="personality-grid">{personalities.map((item) => <button key={item.id} onClick={() => setConfig({ ...config, personality: item.id })} className={config.personality === item.id ? "selected" : ""}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div><label className="field-label">Personality note <span>optional</span></label><textarea value={config.personalityNote} maxLength={240} onChange={(e) => setConfig({ ...config, personalityNote: e.target.value })} placeholder="Loves rainy days and terrible jokes…" /></div>{snapshot.asset?.characterProfile && <div className="control-section capability-section"><h3>Movement profile</h3><p>Detected as {snapshot.asset.characterProfile.skeletonFamily.replaceAll("_", " ")} · {Math.round(snapshot.asset.characterProfile.confidence * 100)}% confidence</p><div className="capability-list">{snapshot.asset.characterProfile.capabilities.filter((value) => !value.startsWith("use_")).map((value) => <span key={value}>{value.replaceAll("_", " ")}</span>)}</div></div>}<div className="control-section"><h3>Chat behavior</h3><p>Choose where conversations appear.</p><div className="chat-mode-grid"><button onClick={() => setConfig({ ...config, chatMode: "on_click" })} className={config.chatMode === "on_click" ? "selected" : ""}><strong>Click pet to chat</strong><span>Open chat from your pet.</span></button><button onClick={() => setConfig({ ...config, chatMode: "glass_widget" })} className={config.chatMode === "glass_widget" ? "selected" : ""}><strong>Glass widget</strong><span>Keep chat on the desktop.</span></button></div></div><div className="control-section"><h3>Desktop behavior</h3><div className="preference-group"><label className="switch-row"><span><strong>Show pet when my computer starts</strong><small>Launch Desk Pal automatically.</small></span><input type="checkbox" checked={config.launchOnStartup} onChange={(e) => setConfig({ ...config, launchOnStartup: e.target.checked })} /><i /></label><label className="switch-row"><span><strong>Stay above other apps</strong><small>Keep your companion visible.</small></span><input type="checkbox" checked={config.overlayMode === "always_on_top"} onChange={(e) => setConfig({ ...config, overlayMode: e.target.checked ? "always_on_top" : "normal" })} /><i /></label></div></div><div className="controls-actions"><button className="danger-button delete-pet-button" onClick={() => setShowDeleteWarning(true)}><Trash2 /> Delete pet</button><button className="primary-button" disabled={busy} onClick={activate}>{busy ? <LoaderCircle className="spin" /> : <><Check /> Save changes</>}</button></div></div>}
        {screen === "controls" && controlTab === "account" && <div className="panel-body controls-panel account-panel"><div className="controls-heading"><div className="panel-icon"><CircleUserRound /></div><div><p className="eyebrow">DESK PAL ACCOUNT</p><h2>Account</h2></div></div><div className="account-notice"><ShieldCheck /><span><strong>Local prototype</strong><small>Account services are not connected yet. Your pet and chat remain on this computer.</small></span></div><div className="account-row"><span className="account-row-icon"><Mail /></span><span><strong>Email</strong><small>Not connected</small></span><button disabled>Connect</button></div><div className="account-row"><span className="account-row-icon"><Sparkles /></span><span><strong>Plan</strong><small>Free prototype</small></span><button disabled>Manage</button></div><div className="account-row"><span className="account-row-icon"><CreditCard /></span><span><strong>Billing</strong><small>No payment method</small></span><button disabled>Manage</button></div><div className="account-section"><span className="account-row-icon"><RefreshCcw /></span><div><strong>Migrate pet</strong><p>Move your pet and preferences to another computer.</p><button className="ghost-button" disabled>Coming soon</button></div></div><div className="account-section danger"><span className="account-row-icon"><Trash2 /></span><div><strong>Delete account</strong><p>Account deletion will become available when accounts are connected.</p><button className="danger-button" disabled>Delete account</button></div></div></div>}
        {screen === "onboarding" && <>
        {step === 0 && <div className="panel-body"><div className="panel-icon"><PawPrint /></div><p className="eyebrow">STEP 1 OF 5</p><h2>Create your 3D Desk Pal</h2><p>Upload one character image and Desk Pal will generate, rig, and animate a desktop-ready 3D companion. You never need to enter a provider API key.</p><div className="service-note"><ShieldCheck size={18} /><span><strong>Your image is used only for pet creation</strong><small>It is sent securely to the Desk Pal generation service; the finished pet and chat stay local.</small></span></div><button className="primary-button" onClick={continueFromWelcome} disabled={busy}>{busy ? <LoaderCircle className="spin" /> : <>Continue <ChevronRight /></>}</button></div>}
        {step === 1 && <div className="panel-body"><div className="panel-icon"><ImagePlus /></div><p className="eyebrow">STEP 2 OF 5</p><h2>Choose your character</h2><p>Use a clear, uncropped full-body image with visible, separated limbs. Simple backgrounds and front or three-quarter views rig best.</p><label className={`drop-zone ${imageUrl ? "has-image" : ""}`}>{imageUrl ? <img src={imageUrl} alt="Selected character" /> : <><ImagePlus size={32} /><strong>Drop an image here</strong><span>or click to browse · PNG, JPG, WebP · max 20 MB</span></>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseFile} /></label><div className="button-row"><button className="ghost-button" onClick={() => setStep(0)}><ChevronLeft /> Back</button><button className="primary-button" disabled={!file || busy} onClick={generate}>{busy ? <LoaderCircle className="spin" /> : <>Create 3D pet <Sparkles /></>}</button></div></div>}
        {step === 2 && <div className="panel-body progress-panel"><div className="creation-orbit"><span className="orbit-ring" /><Sparkles size={34} /></div><p className="eyebrow">STEP 3 OF 5</p><h2>{snapshot.generation.stage === "completed" ? "Your 3D pet is ready" : snapshot.generation.stage === "failed" || snapshot.generation.stage === "cancelled" ? "Creation needs attention" : "Bringing your pet to life"}</h2><p>{snapshot.generation.message || "Preparing your character…"}</p><div className="progress-track"><span style={{ width: `${snapshot.generation.progress}%` }} /></div><div className="progress-meta"><span>{snapshot.generation.stage.replaceAll("_", " ")}</span><span>{Math.round(snapshot.generation.progress)}%</span></div>{snapshot.generation.stage === "completed" ? <button className="primary-button progress-action" onClick={() => setStep(3)}>Preview pet <ChevronRight /></button> : snapshot.generation.stage === "failed" || snapshot.generation.stage === "cancelled" ? <div className="generation-recovery"><button className="primary-button" disabled={!file || busy} onClick={generate}><RefreshCcw /> Try 3D again</button><button className="ghost-button" disabled={busy} onClick={continueWithImage}>Use image pet for now</button><button className="ghost-button" onClick={() => setStep(1)}><ChevronLeft /> Choose another image</button></div> : <button className="ghost-button center progress-action" onClick={cancelCreation}>Cancel creation</button>}</div>}
        {step === 3 && <div className="preview-layout"><div className="preview-stage"><ModelStage url={assetUrl(snapshot.generation.candidateModelPath)} imageUrl={assetUrl(snapshot.generation.candidateSourcePath) ?? imageUrl} interactive /><span>Drag to rotate · scroll to zoom</span></div><div className="preview-copy"><p className="eyebrow">STEP 4 OF 5</p><h2>Meet your new companion</h2><p>{snapshot.generation.candidateModelPath ? `Your ${snapshot.generation.bodyType?.replaceAll("_", " ") ?? "animated"} pet is rigged and ready to roam.` : "You’re using the uploaded image as your pet for now."}</p><button className="primary-button" onClick={() => setStep(4)}>Looks good <ChevronRight /></button><button className="ghost-button center" onClick={() => setStep(1)}>Try another image</button></div></div>}
        {step === 4 && <div className="panel-body personality-panel"><div className="panel-icon"><Sparkles /></div><p className="eyebrow">FINAL STEP</p><h2>Give them a personality</h2><label className="field-label">Pet name</label><input className="text-input" value={config.name} maxLength={28} onChange={(e) => setConfig({ ...config, name: e.target.value })} /><div className="personality-grid">{personalities.map((item) => <button key={item.id} onClick={() => setConfig({ ...config, personality: item.id })} className={config.personality === item.id ? "selected" : ""}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div><label className="field-label">A little extra personality <span>optional</span></label><textarea value={config.personalityNote} maxLength={240} onChange={(e) => setConfig({ ...config, personalityNote: e.target.value })} placeholder="Loves rainy days and terrible jokes…" /><label className="field-label">Chat style</label><div className="chat-mode-grid"><button onClick={() => setConfig({ ...config, chatMode: "on_click" })} className={config.chatMode === "on_click" ? "selected" : ""}><strong>Click pet to chat</strong><span>The glass chat opens only when you click your pet.</span></button><button onClick={() => setConfig({ ...config, chatMode: "glass_widget" })} className={config.chatMode === "glass_widget" ? "selected" : ""}><strong>Glass widget</strong><span>Keep the clear chat panel visible in the background.</span></button></div><div className="preference-group"><label className="switch-row"><span><strong>Show pet when my computer starts</strong><small>You can change this anytime from the tray.</small></span><input type="checkbox" checked={config.launchOnStartup} onChange={(e) => setConfig({ ...config, launchOnStartup: e.target.checked })} /><i /></label><label className="switch-row"><span><strong>Stay above other apps</strong><small>Turn this off for a desktop-only companion.</small></span><input type="checkbox" checked={config.overlayMode === "always_on_top"} onChange={(e) => setConfig({ ...config, overlayMode: e.target.checked ? "always_on_top" : "normal" })} /><i /></label></div><button className="primary-button" disabled={busy} onClick={activate}>{busy ? <LoaderCircle className="spin" /> : <><PawPrint /> Activate {config.name || "pet"}</>}</button></div>}
        </>}
        {activeError && showError && <div className="error-banner" role="alert">{activeError}</div>}
      </div>
    </section>
    {showDeleteWarning && <div className="modal-backdrop" role="presentation"><section className="warning-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-pet-title"><div className="warning-icon"><Trash2 /></div><p className="eyebrow">PERMANENT ACTION</p><h2 id="delete-pet-title">Delete {config.name || "this pet"}?</h2><p>This removes the pet image, personality, preferences, and conversation history from this computer. This cannot be undone.</p><div className="warning-actions"><button className="ghost-button" disabled={busy} onClick={() => setShowDeleteWarning(false)}>Cancel</button><button className="danger-button" disabled={busy} onClick={confirmDeletePet}>{busy ? <LoaderCircle className="spin" /> : <><Trash2 /> Delete pet</>}</button></div></section></div>}
  </main>;
}
