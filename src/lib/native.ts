import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { AppSnapshot, LocalAiReply, PetConfig } from "../types";
import { EMPTY_SNAPSHOT } from "../types";

const browserSnapshot: AppSnapshot = { ...EMPTY_SNAPSHOT };

export async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);
  if (name === "get_app_snapshot") return structuredClone(browserSnapshot) as T;
  if (name === "send_chat") {
    const message = String(args.message ?? "");
    return { reply: `I heard “${message.slice(0, 42)}.” ✦`, emotion: "curious", action: "react", localModel: false } as T;
  }
  return undefined as T;
}

export const getSnapshot = () => command<AppSnapshot>("get_app_snapshot");
export const startGeneration = (dataUrl: string, filename: string) => command<string>("start_generation", { dataUrl, filename });
export const cancelGeneration = () => command<void>("cancel_generation");
export const useImageCandidate = () => command<void>("use_image_candidate");
export const useModelCandidate = () => command<void>("use_model_candidate");
export const activatePet = (config: PetConfig) => command<void>("activate_pet", { config });
export const setPaused = (paused: boolean) => command<void>("set_paused", { paused });
export const setOverlayMode = (mode: PetConfig["overlayMode"]) => command<void>("set_overlay_mode", { mode });
export const setCursorPassThrough = (ignore: boolean) => command<void>("set_cursor_passthrough", { ignore });
export const ensureLocalModel = () => command<void>("ensure_local_model");
export const sendChat = (message: string) => command<LocalAiReply>("send_chat", { message });
export const clearConversation = () => command<void>("clear_conversation");
export const deletePet = () => command<void>("delete_pet");
export const discardPetCandidate = () => command<void>("discard_pet_candidate");
export const saveWidgetPosition = (x: number, y: number) => command<void>("save_widget_position", { x, y });

export function assetUrl(path?: string) {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
}
