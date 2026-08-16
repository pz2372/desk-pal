const HUMANOID_LANDMARKS = [
  ["head", "Top of head"],
  ["pelvis", "Center of hips"],
  ["left_shoulder", "Left shoulder"],
  ["right_shoulder", "Right shoulder"],
  ["left_elbow", "Left elbow"],
  ["right_elbow", "Right elbow"],
  ["left_hand", "Left hand"],
  ["right_hand", "Right hand"],
  ["left_hip", "Left hip joint"],
  ["right_hip", "Right hip joint"],
  ["left_knee", "Left knee"],
  ["right_knee", "Right knee"],
  ["left_foot", "Left foot"],
  ["right_foot", "Right foot"],
];

const QUADRUPED_LANDMARKS = [
  ["head", "Center of head"],
  ["chest", "Center of chest"],
  ["pelvis", "Center of hips"],
  ["front_left_shoulder", "Front left shoulder"],
  ["front_right_shoulder", "Front right shoulder"],
  ["front_left_elbow", "Front left elbow"],
  ["front_right_elbow", "Front right elbow"],
  ["front_left_paw", "Front left paw"],
  ["front_right_paw", "Front right paw"],
  ["back_left_hip", "Back left hip"],
  ["back_right_hip", "Back right hip"],
  ["back_left_knee", "Back left knee"],
  ["back_right_knee", "Back right knee"],
  ["back_left_paw", "Back left paw"],
  ["back_right_paw", "Back right paw"],
];

export const RIG_TEMPLATES = Object.freeze({
  humanoid: Object.freeze({
    id: "desk_pal_humanoid_v2",
    family: "humanoid",
    bones: ["root", "pelvis", "spine", "chest", "neck", "head", "upper_arm_l", "forearm_l", "hand_l", "upper_arm_r", "forearm_r", "hand_r", "thigh_l", "shin_l", "foot_l", "thigh_r", "shin_r", "foot_r"],
    landmarks: HUMANOID_LANDMARKS,
    capabilities: ["idle", "walk", "run", "sit", "sleep", "jump", "wave", "dance", "look_around", "happy", "sad", "use_arms"],
    anatomy: { legs: 2, arms: 2, wings: 0, tails: 0, heads: 1 },
  }),
  quadruped: Object.freeze({
    id: "desk_pal_quadruped_v2",
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
    ...(hasWings ? [["left_wing_root", "Left wing root"], ["right_wing_root", "Right wing root"], ["left_wing_tip", "Left wing tip"], ["right_wing_tip", "Right wing tip"]] : []),
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

// GPT coordinates are followed by a geometric ray hit and a Blender validation
// pass, so this threshold should reject guesses—not merely inferred joints.
export const SMART_RIG_CONFIDENCE = 0.55;

function lerpPoint(start, end, amount) {
  return start.map((value, index) => value + (end[index] - value) * amount);
}

function fillTemplateLandmarks(family, landmarks) {
  const byName = new Map(landmarks.map((landmark) => [landmark.name, landmark]));
  const position = (name) => byName.get(name)?.position;
  const fill = (name, point) => {
    const landmark = byName.get(name);
    if (landmark && !landmark.position && validPoint(point)) Object.assign(landmark, { position: point, confidence: Math.max(landmark.confidence, 0.5), source: "inferred" });
  };
  if (family === "humanoid" && position("pelvis") && position("head")) {
    const chest = lerpPoint(position("pelvis"), position("head"), 0.58);
    for (const side of ["left", "right"]) {
      if (position(`${side}_hand`)) fill(`${side}_shoulder`, lerpPoint(chest, position(`${side}_hand`), 0.24));
      if (position(`${side}_shoulder`) && position(`${side}_hand`)) fill(`${side}_elbow`, lerpPoint(position(`${side}_shoulder`), position(`${side}_hand`), 0.55));
      if (position(`${side}_foot`)) fill(`${side}_hip`, lerpPoint(position("pelvis"), position(`${side}_foot`), 0.16));
      if (position(`${side}_hip`) && position(`${side}_foot`)) fill(`${side}_knee`, lerpPoint(position(`${side}_hip`), position(`${side}_foot`), 0.56));
    }
  }
  if (family === "quadruped" && position("chest") && position("pelvis")) {
    for (const side of ["left", "right"]) {
      if (position(`front_${side}_paw`)) fill(`front_${side}_shoulder`, lerpPoint(position("chest"), position(`front_${side}_paw`), 0.15));
      if (position(`front_${side}_shoulder`) && position(`front_${side}_paw`)) fill(`front_${side}_elbow`, lerpPoint(position(`front_${side}_shoulder`), position(`front_${side}_paw`), 0.55));
      if (position(`back_${side}_paw`)) fill(`back_${side}_hip`, lerpPoint(position("pelvis"), position(`back_${side}_paw`), 0.15));
      if (position(`back_${side}_hip`) && position(`back_${side}_paw`)) fill(`back_${side}_knee`, lerpPoint(position(`back_${side}_hip`), position(`back_${side}_paw`), 0.55));
    }
  }
  return landmarks;
}

export function mergeSmartRigAnalysis(vision, projected, fallbackFamily = "humanoid") {
  const family = ["humanoid", "quadruped"].includes(vision?.family) ? vision.family : fallbackFamily;
  const guide = createRigAnalysis(family === "quadruped" ? "quadruped" : "biped", false, {
    family,
    hasTail: Boolean(vision?.hasTail),
    hasWings: Boolean(vision?.hasWings),
  });
  const visionPoints = new Map((Array.isArray(vision?.landmarks) ? vision.landmarks : []).map((point) => [point.name, point]));
  const projectedPoints = new Map((Array.isArray(projected?.landmarks) ? projected.landmarks : []).map((point) => [point.name, point.position]));
  const landmarks = fillTemplateLandmarks(family, guide.landmarks.map((landmark) => {
    const detected = visionPoints.get(landmark.name);
    const position = projectedPoints.get(landmark.name);
    const confidence = Number(detected?.confidence || 0);
    const usable = Boolean(confidence >= SMART_RIG_CONFIDENCE && validPoint(position));
    return { ...landmark, position: usable ? position.map(Number) : undefined, confidence, source: "inferred" };
  }));
  const complete = landmarks.every((landmark) => !landmark.required || Boolean(landmark.position));
  const confidence = landmarks.length ? landmarks.reduce((sum, landmark) => sum + landmark.confidence, 0) / landmarks.length : 0;
  return { ...guide, status: complete ? "corrected" : "needs_correction", confidence, landmarks };
}

export function validateBlenderGuide(guide) {
  if (!guide || !["humanoid", "quadruped"].includes(guide.family)) throw new Error("The Blender rig guide has an unsupported body family.");
  const template = RIG_TEMPLATES[guide.family];
  if (guide.templateId !== template.id) throw new Error("The Blender rig guide uses the wrong skeleton template.");
  const names = new Set();
  for (const landmark of Array.isArray(guide.landmarks) ? guide.landmarks : []) {
    if (names.has(landmark.name)) throw new Error(`The Blender rig guide repeats ${landmark.name}.`);
    names.add(landmark.name);
    if (landmark.required && !validPoint(landmark.position)) throw new Error(`The Blender rig guide is missing ${landmark.label.toLowerCase()}.`);
    if (landmark.position && !validPoint(landmark.position)) throw new Error(`The Blender coordinate for ${landmark.label.toLowerCase()} is invalid.`);
  }
  for (const [name, label] of template.landmarks) if (!names.has(name)) throw new Error(`The Blender rig guide is missing ${label.toLowerCase()}.`);
  return guide;
}
