import { Download, Send, Sparkles, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { cursorPosition, getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSnapshot, LocalAiReply, PetAction } from "../types";
import { EMPTY_SNAPSHOT } from "../types";
import { assetUrl, ensureLocalModel, getSnapshot, sendChat, setCursorPassThrough } from "../lib/native";
import { ModelStage } from "./ModelStage";

export function PetOverlay() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [chatOpen, setChatOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [reply, setReply] = useState<LocalAiReply>();
  const [showPetReply, setShowPetReply] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [action, setAction] = useState<PetAction>("idle");
  const [direction, setDirection] = useState(1);
  const position = useRef({ x: 80, last: performance.now() });
  const persistentChat = snapshot.pet?.chatMode === "glass_widget";

  useEffect(() => {
    const refresh = () => getSnapshot().then(setSnapshot);
    refresh();
    const timer = setInterval(refresh, snapshot.modelDownload.downloading ? 700 : 4000);
    const stop = isTauri() ? listen("pet-updated", refresh) : Promise.resolve(() => {});
    const replyStop = isTauri() ? listen<LocalAiReply>("pet-chat-reply", ({ payload }) => {
      setReply(payload); setAction(payload.action); setThinking(false); setChatOpen(false); setShowPetReply(true);
    }) : Promise.resolve(() => {});
    return () => { clearInterval(timer); stop.then((unlisten) => unlisten()); replyStop.then((unlisten) => unlisten()); };
  }, [snapshot.modelDownload.downloading]);

  useEffect(() => {
    if (persistentChat) setChatOpen(false);
  }, [persistentChat]);

  useEffect(() => {
    if (!isTauri()) return;
    let frame = 0;
    const windowHandle = getCurrentWindow();
    const tick = async (now: number) => {
      if (!snapshot.paused && !chatOpen) {
        const delta = Math.min(0.05, (now - position.current.last) / 1000);
        const width = 380;
        const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
        const left = screen.availLeft ?? 0;
        const right = left + window.screen.availWidth - width;
        position.current.x += direction * 34 * delta;
        if (position.current.x >= right) { position.current.x = right; setDirection(-1); setAction("turn"); }
        else if (position.current.x <= left) { position.current.x = left; setDirection(1); setAction("turn"); }
        else setAction("walk");
        await windowHandle.setPosition(new LogicalPosition(position.current.x, (screen.availTop ?? 0) + screen.availHeight - 520));
      } else setAction("idle");
      position.current.last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [snapshot.paused, chatOpen, direction]);

  useEffect(() => {
    if (!isTauri()) return;
    let ignored = false;
    const timer = window.setInterval(async () => {
      try {
        const win = getCurrentWindow();
        const [cursor, origin] = await Promise.all([cursorPosition(), win.outerPosition()]);
        const scale = await win.scaleFactor();
        const x = cursor.x / scale - origin.x / scale;
        const y = cursor.y / scale - origin.y / scale;
        const overPet = x >= 70 && x <= 310 && y >= 170 && y <= 510;
        const overBubble = chatOpen && !persistentChat && x >= 8 && x <= 372 && y >= 8 && y <= 205;
        const overReply = showPetReply && x >= 10 && x <= 255 && y >= 150 && y <= 290;
        const next = !(overPet || overBubble || overReply);
        if (next !== ignored) { ignored = next; await setCursorPassThrough(next); }
      } catch { /* window can disappear while polling */ }
    }, 90);
    return () => clearInterval(timer);
  }, [chatOpen, persistentChat, showPetReply]);

  useEffect(() => {
    if (!chatOpen || persistentChat) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setChatOpen(false); };
    window.addEventListener("keydown", close);
    const idle = window.setTimeout(() => setChatOpen(false), 90_000);
    return () => { window.removeEventListener("keydown", close); clearTimeout(idle); };
  }, [chatOpen, message, reply, persistentChat]);

  useEffect(() => {
    if (!showPetReply) return;
    const timer = window.setTimeout(() => setShowPetReply(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [showPetReply, reply]);

  function toggleChat() {
    setAction("jump");
    if (!persistentChat) { setShowPetReply(false); setChatOpen((value) => !value); }
    window.setTimeout(() => setAction("idle"), 800);
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); if (!message.trim() || thinking) return;
    const sent = message.trim();
    setMessage(""); setLastSent(sent); setReply(undefined); setThinking(true);
    setChatOpen(false); setShowPetReply(true);
    try {
      const value = await Promise.race<LocalAiReply>([
        sendChat(sent),
        new Promise((resolve) => window.setTimeout(() => resolve({ reply: `Hi! ${snapshot.pet?.name ?? "Your pet"} is glad you stopped by.`, emotion: "happy", action: "jump", localModel: false }), 6000))
      ]);
      setReply(value); setAction(value.action);
    }
    catch {
      setReply({ reply: "I’m a little sleepy right now. Try again in a moment?", emotion: "sleepy", action: "idle", localModel: false });
      setChatOpen(false); setShowPetReply(true);
    }
    finally { setThinking(false); }
  }

  const modelUrl = assetUrl(snapshot.asset?.modelPath);
  const imageUrl = !modelUrl ? assetUrl(snapshot.asset?.sourceImagePath) : undefined;
  return <main className="pet-shell">
    {chatOpen && !persistentChat && <section className={`chat-bubble emotion-${reply?.emotion ?? "calm"}`}>
      <header><span><Sparkles size={14} /> {snapshot.pet?.name ?? "Your pet"}</span><button onClick={() => setChatOpen(false)} aria-label="Close chat"><X size={16} /></button></header>
      <div className="attached-chat-thread">
        {lastSent && <div className="attached-user-message">{lastSent}</div>}
        <div className="attached-pet-response"><small>{snapshot.pet?.name ?? "Your pet"}</small><div className="attached-pet-message"><div className="chat-copy">{thinking ? <span className="typing"><i /><i /><i /></span> : reply?.reply ?? `Hi! I’m ${snapshot.pet?.name ?? "your new companion"}. What are you thinking about?`}</div></div></div>
      </div>
      {!snapshot.modelInstalled && <button className="model-download" disabled={snapshot.modelDownload.downloading} onClick={() => ensureLocalModel().then(() => getSnapshot().then(setSnapshot))}><Download size={13} /> {snapshot.modelDownload.downloading ? `Downloading local AI · ${Math.round(snapshot.modelDownload.progress)}%` : "Enable private local AI · 639 MB"}</button>}
      <form onSubmit={submit}><input autoFocus value={message} maxLength={300} onChange={(e) => setMessage(e.target.value)} placeholder="Say something…" /><button disabled={!message.trim() || thinking}><Send size={15} /></button></form>
    </section>}
    {showPetReply && <button className={`pet-speech-bubble emotion-${reply?.emotion ?? "curious"}`} onClick={() => setShowPetReply(false)} aria-label="Dismiss pet response">
      <small>{snapshot.pet?.name ?? "Your pet"}</small>
      <span>{thinking ? <span className="typing speech-typing"><i /><i /><i /></span> : reply?.reply ?? "I’m thinking…"}</span>
    </button>}
    <div className="pet-canvas" aria-label="Desktop pet"><ModelStage url={modelUrl} imageUrl={imageUrl} action={action} facing={direction} onClick={toggleChat} /></div>
    <div className="pet-shadow" />
  </main>;
}
