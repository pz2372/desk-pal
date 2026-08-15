export type AppLifecycle = "needs_setup" | "generating" | "ready";
export type Personality = "friendly" | "sassy" | "calm" | "chaotic";
export type BodyType = "biped" | "quadruped" | "hexapod" | "octopod" | "avian" | "serpentine" | "aquatic" | "unknown";
export type SkeletonFamily = "humanoid" | "quadruped" | "flying" | "serpentine" | "aquatic" | "unsupported";
export type RigFamily = "humanoid" | "quadruped" | "unsupported";
export type RigStatus = "ready" | "needs_correction" | "corrected" | "unavailable";
export type PetCapability = "idle" | "walk" | "run" | "sit" | "lie" | "sleep" | "jump" | "fly" | "hover" | "land" | "take_off" | "glide" | "swim" | "wave" | "dance" | "play" | "attack" | "look_around" | "happy" | "sad" | "use_arms" | "use_tail" | "use_wings";
export type OverlayMode = "normal" | "always_on_top";
export type ChatMode = "on_click" | "glass_widget";
export type Emotion = "happy" | "curious" | "calm" | "sleepy" | "surprised" | "annoyed";
export type PetAction = "idle" | "walk" | "turn" | "jump" | "react";
export type GenerationStage = "idle" | "uploading" | "generating" | "rig_check" | "needs_correction" | "rigging" | "animating" | "downloading" | "completed" | "failed" | "cancelled";

export interface RigLandmark {
  name: string;
  label: string;
  position?: [number, number, number];
  confidence: number;
  source: "provider" | "user" | "inferred";
  required: boolean;
}

export interface RigAnalysis {
  templateId: string;
  family: RigFamily;
  status: RigStatus;
  confidence: number;
  anatomy: { legs: number; arms: number; wings: number; tails: number; heads: number };
  capabilities: PetCapability[];
  landmarks: RigLandmark[];
}

export interface PetConfig {
  name: string;
  personality: Personality;
  personalityNote: string;
  launchOnStartup: boolean;
  overlayMode: OverlayMode;
  chatMode: ChatMode;
}

export interface PetAsset {
  modelPath?: string;
  sourceImagePath: string;
  bodyType: BodyType;
  characterProfile: CharacterProfile;
  rigAnalysis?: RigAnalysis;
  createdAt: string;
}

export interface PetRecord {
  id: string;
  config: PetConfig;
  asset: PetAsset;
  paused: boolean;
  visible: boolean;
}

export interface CharacterProfile {
  species: string;
  skeletonFamily: SkeletonFamily;
  anatomy: { legs: number; arms: number; wings: number; tails: number; heads: number };
  capabilities: PetCapability[];
  confidence: number;
}

export interface GenerationState {
  id?: string;
  stage: GenerationStage;
  progress: number;
  message: string;
  error?: string;
  taskId?: string;
  candidateModelPath?: string;
  candidateSourcePath?: string;
  bodyType?: BodyType;
  rigAnalysis?: RigAnalysis;
}

export interface AppSnapshot {
  lifecycle: AppLifecycle;
  pet?: PetConfig;
  asset?: PetAsset;
  generation: GenerationState;
  paused: boolean;
  visible: boolean;
  modelInstalled: boolean;
  modelDownload: { downloading: boolean; progress: number; error?: string };
  widgetPosition?: { x: number; y: number };
  pets: PetRecord[];
  selectedPetId?: string;
}

export interface LocalAiReply {
  reply: string;
  emotion: Emotion;
  action: PetAction;
  localModel: boolean;
}

export interface ChatTurn { role: "user" | "assistant"; content: string; }

export const EMPTY_SNAPSHOT: AppSnapshot = {
  lifecycle: "needs_setup",
  generation: { stage: "idle", progress: 0, message: "Ready" },
  paused: false,
  visible: true,
  modelInstalled: false,
  modelDownload: { downloading: false, progress: 0 },
  pets: []
};
