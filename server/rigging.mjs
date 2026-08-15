const HUMANOID_LANDMARKS = [
  ["head", "Top of head"],
  ["pelvis", "Center of hips"],
  ["left_hand", "Left hand"],
  ["right_hand", "Right hand"],
  ["left_foot", "Left foot"],
  ["right_foot", "Right foot"],
];

const QUADRUPED_LANDMARKS = [
  ["head", "Center of head"],
  ["chest", "Center of chest"],
  ["pelvis", "Center of hips"],
  ["front_left_paw", "Front left paw"],
  ["front_right_paw", "Front right paw"],
  ["back_left_paw", "Back left paw"],
  ["back_right_paw", "Back right paw"],
];

export const RIG_TEMPLATES = Object.freeze({
  humanoid: Object.freeze({
    id: "desk_pal_humanoid_v1",
    family: "humanoid",
    bones: ["root", "pelvis", "spine", "chest", "neck", "head", "upper_arm_l", "forearm_l", "hand_l", "upper_arm_r", "forearm_r", "hand_r", "thigh_l", "shin_l", "foot_l", "thigh_r", "shin_r", "foot_r"],
    landmarks: HUMANOID_LANDMARKS,
    capabilities: ["idle", "walk", "run", "sit", "sleep", "jump", "wave", "dance", "look_around", "happy", "sad", "use_arms"],
    anatomy: { legs: 2, arms: 2, wings: 0, tails: 0, heads: 1 },
  }),
  quadruped: Object.freeze({
    id: "desk_pal_quadruped_v1",
    family: "quadruped",
    bones: ["root", "pelvis", "spine", "chest", "neck", "head", "front_upper_l", "front_lower_l", "front_paw_l", "front_upper_r", "front_lower_r", "front_paw_r", "back_upper_l", "back_lower_l", "back_paw_l", "back_upper_r", "back_lower_r", "back_paw_r"],
    landmarks: QUADRUPED_LANDMARKS,
    capabilities: ["idle", "walk", "run", "sit", "lie", "sleep", "jump", "play", "look_around", "happy", "sad"],
    anatomy: { legs: 4, arms: 0, wings: 0, tails: 0, heads: 1 },
  }),
});

export function familyForBodyType(bodyType) {
  if (["biped", "humanoid"].includes(bodyType)) return "humanoid";
  if (bodyType === "quadruped") return "quadruped";
  return undefined;
}

export function createRigAnalysis(bodyType, riggable, options = {}) {
  const family = options.family || familyForBodyType(bodyType);
  const template = RIG_TEMPLATES[family];
  if (!template) throw new Error("Only humanoid and quadruped rig guides are supported right now.");
  const hasTail = Boolean(options.hasTail);
  const hasWings = Boolean(options.hasWings);
  const extras = [
    ...(hasTail ? [["tail_base", "Base of tail"], ["tail_tip", "Tip of tail"]] : []),
    ...(hasWings ? [["left_wing_tip", "Left wing tip"], ["right_wing_tip", "Right wing tip"]] : []),
  ];
  return {
    templateId: template.id,
    family,
    status: riggable ? "ready" : "needs_correction",
    confidence: riggable ? 0.9 : 0.42,
    anatomy: { ...template.anatomy, tails: hasTail ? 1 : 0, wings: hasWings ? 2 : 0 },
    capabilities: [...template.capabilities, ...(hasTail ? ["use_tail"] : []), ...(hasWings ? ["use_wings"] : [])],
    landmarks: [...template.landmarks, ...extras].map(([name, label]) => ({ name, label, confidence: riggable ? 0.9 : 0, source: riggable ? "provider" : "user", required: true })),
  };
}

function validPoint(position) {
  return Array.isArray(position) && position.length === 3 && position.every((value) => Number.isFinite(value) && Math.abs(value) <= 100000);
}

export function validateRigCorrections(payload) {
  const family = String(payload?.family || "");
  const guide = createRigAnalysis(family === "quadruped" ? "quadruped" : "biped", false, {
    family,
    hasTail: payload?.hasTail,
    hasWings: payload?.hasWings,
  });
  const supplied = new Map((Array.isArray(payload?.landmarks) ? payload.landmarks : []).map((landmark) => [String(landmark?.name), landmark]));
  const landmarks = guide.landmarks.map((landmark) => {
    const correction = supplied.get(landmark.name);
    if (!correction || !validPoint(correction.position)) throw new Error(`Choose a point for ${landmark.label.toLowerCase()}.`);
    return { ...landmark, position: correction.position.map(Number), confidence: 1, source: "user" };
  });
  return { ...guide, status: "corrected", confidence: 1, landmarks };
}
