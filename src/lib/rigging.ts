import type { PetCapability, RigAnalysis, RigFamily, RigLandmark } from "../types";

const LANDMARKS: Record<Exclude<RigFamily, "unsupported">, Array<[string, string]>> = {
  humanoid: [
    ["head", "Top of head"], ["pelvis", "Center of hips"],
    ["left_hand", "Left hand"], ["right_hand", "Right hand"],
    ["left_foot", "Left foot"], ["right_foot", "Right foot"],
  ],
  quadruped: [
    ["head", "Center of head"], ["chest", "Center of chest"], ["pelvis", "Center of hips"],
    ["front_left_paw", "Front left paw"], ["front_right_paw", "Front right paw"],
    ["back_left_paw", "Back left paw"], ["back_right_paw", "Back right paw"],
  ],
};

const CAPABILITIES: Record<Exclude<RigFamily, "unsupported">, PetCapability[]> = {
  humanoid: ["idle", "walk", "run", "sit", "sleep", "jump", "wave", "dance", "look_around", "happy", "sad", "use_arms"],
  quadruped: ["idle", "walk", "run", "sit", "lie", "sleep", "jump", "play", "look_around", "happy", "sad"],
};

export function createCorrectionGuide(previous: RigAnalysis | undefined, family: Exclude<RigFamily, "unsupported">, hasTail: boolean, hasWings: boolean): RigAnalysis {
  const saved = new Map((previous?.landmarks ?? []).map((landmark) => [landmark.name, landmark.position]));
  const extras: Array<[string, string]> = [
    ...(hasTail ? [["tail_base", "Base of tail"], ["tail_tip", "Tip of tail"]] as Array<[string, string]> : []),
    ...(hasWings ? [["left_wing_tip", "Left wing tip"], ["right_wing_tip", "Right wing tip"]] as Array<[string, string]> : []),
  ];
  const landmarks: RigLandmark[] = [...LANDMARKS[family], ...extras].map(([name, label]) => ({
    name, label, position: saved.get(name), confidence: saved.has(name) ? 1 : 0, source: "user", required: true,
  }));
  return {
    templateId: `desk_pal_${family}_v1`, family, status: "needs_correction", confidence: 0.42,
    anatomy: { legs: family === "humanoid" ? 2 : 4, arms: family === "humanoid" ? 2 : 0, wings: hasWings ? 2 : 0, tails: hasTail ? 1 : 0, heads: 1 },
    capabilities: [...CAPABILITIES[family], ...(hasTail ? ["use_tail" as const] : []), ...(hasWings ? ["use_wings" as const] : [])],
    landmarks,
  };
}

export const firstMissingLandmark = (analysis?: RigAnalysis) => analysis?.landmarks.find((landmark) => !landmark.position);
