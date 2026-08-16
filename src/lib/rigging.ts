import type { PetCapability, RigAnalysis, RigFamily, RigLandmark } from "../types";

const LANDMARKS: Record<Exclude<RigFamily, "unsupported">, Array<[string, string]>> = {
  humanoid: [
    ["head", "Top of head"], ["pelvis", "Center of hips"],
    ["left_shoulder", "Left shoulder"], ["right_shoulder", "Right shoulder"],
    ["left_elbow", "Left elbow"], ["right_elbow", "Right elbow"],
    ["left_hand", "Left hand"], ["right_hand", "Right hand"],
    ["left_hip", "Left hip joint"], ["right_hip", "Right hip joint"],
    ["left_knee", "Left knee"], ["right_knee", "Right knee"],
    ["left_foot", "Left foot"], ["right_foot", "Right foot"],
  ],
  quadruped: [
    ["head", "Center of head"], ["chest", "Center of chest"], ["pelvis", "Center of hips"],
    ["front_left_shoulder", "Front left shoulder"], ["front_right_shoulder", "Front right shoulder"],
    ["front_left_elbow", "Front left elbow"], ["front_right_elbow", "Front right elbow"],
    ["front_left_paw", "Front left paw"], ["front_right_paw", "Front right paw"],
    ["back_left_hip", "Back left hip"], ["back_right_hip", "Back right hip"],
    ["back_left_knee", "Back left knee"], ["back_right_knee", "Back right knee"],
    ["back_left_paw", "Back left paw"], ["back_right_paw", "Back right paw"],
  ],
};

const CAPABILITIES: Record<Exclude<RigFamily, "unsupported">, PetCapability[]> = {
  humanoid: ["idle", "walk", "run", "sit", "sleep", "jump", "wave", "dance", "look_around", "happy", "sad", "use_arms"],
  quadruped: ["idle", "walk", "run", "sit", "lie", "sleep", "jump", "play", "look_around", "happy", "sad"],
};

export function createCorrectionGuide(previous: RigAnalysis | undefined, family: Exclude<RigFamily, "unsupported">, hasTail: boolean, hasWings: boolean): RigAnalysis {
  const saved = new Map((previous?.landmarks ?? []).map((landmark) => [landmark.name, landmark]));
  const extras: Array<[string, string]> = [
    ...(hasTail ? [["tail_base", "Base of tail"], ["tail_tip", "Tip of tail"]] as Array<[string, string]> : []),
    ...(hasWings ? [["left_wing_root", "Left wing root"], ["right_wing_root", "Right wing root"], ["left_wing_tip", "Left wing tip"], ["right_wing_tip", "Right wing tip"]] as Array<[string, string]> : []),
  ];
  const landmarks: RigLandmark[] = [...LANDMARKS[family], ...extras].map(([name, label]) => ({
    name, label, position: saved.get(name)?.position, confidence: saved.get(name)?.confidence ?? 0, source: saved.get(name)?.source ?? "user", required: true,
  }));
  return {
    templateId: `desk_pal_${family}_v2`, family, status: "needs_correction", confidence: previous?.confidence ?? 0.42,
    anatomy: { legs: family === "humanoid" ? 2 : 4, arms: family === "humanoid" ? 2 : 0, wings: hasWings ? 2 : 0, tails: hasTail ? 1 : 0, heads: 1 },
    capabilities: [...CAPABILITIES[family], ...(hasTail ? ["use_tail" as const] : []), ...(hasWings ? ["use_wings" as const] : [])],
    landmarks,
  };
}

export const firstMissingLandmark = (analysis?: RigAnalysis) => analysis?.landmarks.find((landmark) => !landmark.position);
