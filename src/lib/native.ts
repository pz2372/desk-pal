import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type { AppSnapshot, InitialAnatomyProfile, LocalAiReply, PetConfig, PreflightImage, PreflightResult, RigAnalysis } from "../types";
import { EMPTY_SNAPSHOT } from "../types";

const browserSnapshot: AppSnapshot = { ...EMPTY_SNAPSHOT };

export async function command<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) return invoke<T>(name, args);
  if (name === "get_app_snapshot" || name === "get_pet_snapshot") return structuredClone(browserSnapshot) as T;
  if (name === "send_chat") {
    const message = String(args.message ?? "");
    return { reply: `I heard “${message.slice(0, 42)}.” ✦`, emotion: "curious", action: "react", localModel: false } as T;
  }
  if (name === "preflight_images") return { passed: true, summary: "Images are ready.", images: (args.dataUrls as string[] || []).map((_, index) => ({ index, angle: index === 0 ? "front" : index === 1 ? "left" : "back", description: "Browser preview" })), issues: [], anatomy: { family: "humanoid", species: "browser_preview", hasTail: false, hasWings: false, confidence: 0.8, explanation: "Browser preview anatomy", landmarks: [] } } as T;
  return undefined as T;
}

export const getSnapshot = () => command<AppSnapshot>("get_app_snapshot");
export const getPetSnapshot = (petId: string) => command<AppSnapshot>("get_pet_snapshot", { petId });
export const selectPet = (petId: string) => command<void>("select_pet", { petId });
export const preflightImages = (dataUrls: string[]) => command<PreflightResult>("preflight_images", { dataUrls });
export const startGeneration = (dataUrls: string[], filenames: string[], views: PreflightImage[], anatomy: InitialAnatomyProfile) => command<string>("start_generation", { dataUrls, filenames, views, anatomy });
export const cancelGeneration = () => command<void>("cancel_generation");
export const useImageCandidate = () => command<void>("use_image_candidate");
export const useModelCandidate = () => command<void>("use_model_candidate");
export const submitRigCorrections = (analysis: RigAnalysis) => command<void>("submit_rig_corrections", { analysis });
export const retryRigging = () => command<void>("retry_rigging");
export const retryAnimation = () => command<void>("retry_animation");
export const activatePet = (config: PetConfig) => command<void>("activate_pet", { config });
export const setPaused = (paused: boolean, petId?: string) => command<void>("set_paused", { paused, petId });
export const setOverlayMode = (mode: PetConfig["overlayMode"], petId?: string) => command<void>("set_overlay_mode", { mode, petId });
export const setCursorPassThrough = (ignore: boolean) => command<void>("set_cursor_passthrough", { ignore });
export const ensureLocalModel = () => command<void>("ensure_local_model");
export const sendChat = (message: string, petId?: string) => command<LocalAiReply>("send_chat", { message, petId });
export const clearConversation = () => command<void>("clear_conversation");
export const deletePet = () => command<void>("delete_pet");
export const discardPetCandidate = () => command<void>("discard_pet_candidate");
export const saveWidgetPosition = (x: number, y: number) => command<void>("save_widget_position", { x, y });

export function assetUrl(path?: string) {
  if (!path) return undefined;
  return isTauri() ? convertFileSrc(path) : path;
}
