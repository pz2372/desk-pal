import { Download, Send, Sparkles } from "lucide-react";
import { FormEvent, MouseEvent, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import type { AppSnapshot, LocalAiReply } from "../types";
import { EMPTY_SNAPSHOT } from "../types";
import { ensureLocalModel, getSnapshot, saveWidgetPosition, sendChat } from "../lib/native";

export function ChatWidget() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<LocalAiReply>();
  const [messages, setMessages] = useState<{ role: "user" | "pet"; text: string }[]>([]);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    const refresh = () => getSnapshot().then(setSnapshot);
    refresh();
    const timer = window.setInterval(refresh, snapshot.modelDownload.downloading ? 700 : 4000);
    const stop = listen("pet-updated", refresh);
    return () => { window.clearInterval(timer); stop.then((unlisten) => unlisten()); };
  }, [snapshot.modelDownload.downloading]);

  useEffect(() => {
    let stopped = false;
    let saveTimer = 0;
    const windowHandle = getCurrentWindow();
    const placeInSafeDesktopArea = async () => {
      const screenInfo = window.screen as Screen & { availLeft?: number; availTop?: number };
      const width = 400;
      const height = 520;
      const left = screenInfo.availLeft ?? 0;
      const top = screenInfo.availTop ?? 0;
      const right = left + screenInfo.availWidth - width;
      const bottom = top + screenInfo.availHeight - height;
      const isMac = /Mac/i.test(navigator.platform);
      const saved = (await getSnapshot()).widgetPosition;
      const fallbackX = isMac ? left + 20 : right - 20;
      const x = Math.min(right, Math.max(left, saved?.x ?? fallbackX));
      const y = Math.min(bottom, Math.max(top, saved?.y ?? top + 20));
      if (!stopped) await windowHandle.setPosition(new LogicalPosition(x, y));
    };
    void placeInSafeDesktopArea();
    const moved = windowHandle.onMoved(async ({ payload }) => {
      const scale = await windowHandle.scaleFactor();
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void saveWidgetPosition(payload.x / scale, payload.y / scale), 250);
    });
    return () => { stopped = true; window.clearTimeout(saveTimer); moved.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (!snapshot.pet || messages.length) return;
    setMessages([{ role: "pet", text: `Hi! I’m ${snapshot.pet.name || "your companion"}. What are you thinking about?` }]);
  }, [snapshot.pet, messages.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || thinking) return;
    const sent = message.trim();
    setMessage(""); setThinking(true); setMessages((value) => [...value, { role: "user", text: sent }]);
    try {
      const response = await sendChat(sent);
      setReply(response); setMessages((value) => [...value, { role: "pet", text: response.reply }]);
    }
    catch {
      const fallback: LocalAiReply = { reply: "I’m a little sleepy right now. Try again in a moment?", emotion: "sleepy", action: "idle", localModel: false };
      setReply(fallback); setMessages((value) => [...value, { role: "pet", text: fallback.reply }]);
    }
    finally { setThinking(false); }
  }

  function startWindowDrag(event: MouseEvent<HTMLElement>) {
    if (event.button === 0) void getCurrentWindow().startDragging();
  }

  return <main className="widget-shell">
    <section className={`chat-bubble persistent message-widget emotion-${reply?.emotion ?? "calm"}`}>
      <header className="widget-drag-handle" data-tauri-drag-region onMouseDown={startWindowDrag}><span><Sparkles size={14} /> {snapshot.pet?.name ?? "Your pet"}</span><small>Desk Pal</small></header>
      <div className="message-thread">{messages.map((item, index) => <div className={`message-row ${item.role}`} key={`${item.role}-${index}`}><div className="message-balloon">{item.text}</div></div>)}{thinking && <div className="message-row pet"><div className="message-balloon"><span className="typing"><i /><i /><i /></span></div></div>}</div>
      {!snapshot.modelInstalled && <button className="model-download" disabled={snapshot.modelDownload.downloading} onClick={() => ensureLocalModel().then(() => getSnapshot().then(setSnapshot))}><Download size={13} /> {snapshot.modelDownload.downloading ? `Downloading local AI · ${Math.round(snapshot.modelDownload.progress)}%` : "Enable private local AI · 639 MB"}</button>}
      <form onSubmit={submit}><input value={message} maxLength={300} onChange={(e) => setMessage(e.target.value)} placeholder="Say something…" /><button disabled={!message.trim() || thinking}><Send size={15} /></button></form>
    </section>
  </main>;
}
