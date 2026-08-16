const FAMILIES = ["humanoid", "quadruped", "unsupported"];
const VIEWS = ["front", "front_left", "left", "back", "right", "front_right"];
const LANDMARKS = [
  "head", "chest", "pelvis",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_foot", "right_foot",
  "front_left_shoulder", "front_right_shoulder", "front_left_elbow", "front_right_elbow", "front_left_paw", "front_right_paw",
  "back_left_hip", "back_right_hip", "back_left_knee", "back_right_knee", "back_left_paw", "back_right_paw",
  "tail_base", "tail_tip", "left_wing_root", "right_wing_root", "left_wing_tip", "right_wing_tip",
];

export const ANATOMY_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    family: { type: "string", enum: FAMILIES }, species: { type: "string" },
    hasTail: { type: "boolean" }, hasWings: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 }, explanation: { type: "string" },
    landmarks: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      name: { type: "string", enum: LANDMARKS }, view: { type: "string", enum: VIEWS },
      x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 }, visible: { type: "boolean" }, explanation: { type: "string" },
    }, required: ["name", "view", "x", "y", "confidence", "visible", "explanation"] } },
  },
  required: ["family", "species", "hasTail", "hasWings", "confidence", "explanation", "landmarks"],
};

export const ANATOMY_PROMPT = `You are the anatomical planning stage of an automatic Blender rigging pipeline. Your output is not a general description or an illustration: it supplies 2D landmark coordinates that will be ray-projected onto the actual completed GLB and used to build its skeleton.

INPUT CONTRACT
- Original character images appear first. Use them to understand identity, anatomy, and appendages.
- An image-only anatomy profile created before 3D generation is provided as a prior. Verify it against the GLB rather than discarding it.
- Six neutral orthographic renders of the completed GLB follow, each explicitly labeled front, front_left, left, back, right, or front_right.
- Original images are semantic references only. Every returned x/y coordinate MUST refer to one labeled GLB render.

BODY CONTRACT
- First identify the character, creature, or closest known design when possible. Use your learned knowledge of that identity as a strong anatomical prior, but never as the final decision.
- Resolve anatomy in this order: (1) the completed GLB geometry, because Blender must rig what exists; (2) the original images, to interpret ambiguous geometry and intentional effects; (3) learned character/species knowledge, to guide interpretation and detect likely mistakes. State important conflicts in explanation.
- A known design may be customized or the generated GLB may omit or distort a feature. Override prior knowledge only when the original images or multiple GLB views provide clear contradictory evidence. When evidence remains ambiguous, keep the visual interpretation with lower confidence rather than confidently inventing anatomy.
- Choose humanoid for an upright creature with two legs and two arm-like forelimbs, including stylized fantasy creatures.
- Choose quadruped for a creature whose four limbs primarily support locomotion.
- Choose unsupported only when neither canonical skeleton can reasonably animate the model.
- Distinguish deformable anatomy from fire, glow, smoke, hair, clothing, props, and accessories. Effects attached to a tail tip remain effects and must never become wings or independent limbs.
- Use the character's anatomical left and right, never the viewer's left and right.

LANDMARK CONTRACT
- x is normalized left-to-right and y is normalized top-to-bottom in the selected GLB render, both in 0..1.
- Select the render where that body region is most clearly separated from other geometry.
- Put coordinates at the anatomical joint center inside the character silhouette, not on its outline.
- All skeleton joints are under the skin. Set visible=true when the selected render provides a usable body-region coordinate for ray projection, even when the precise joint center is anatomically inferred.
- If a far-side joint is occluded in one render, use another render. If necessary, infer it using bilateral symmetry and still choose the render where that inferred ray passes through the correct limb.
- Set visible=false only when none of the six GLB renders provides a usable ray through that body region. Reduce confidence for inferred points, but always provide the best coordinate.

Return every required landmark exactly once.
Humanoid: head (top/center of skull), pelvis (center between hips), left/right shoulder, elbow, hand/wrist, hip, knee, and foot/ankle.
Quadruped: head, chest, pelvis, front left/right shoulder, elbow, paw, and back left/right hip, knee, paw.
If a tail exists in the GLB, add tail_base at its attachment to the body and tail_tip at the end of its deformable geometry; exclude flame, smoke, or another visual effect from the deformable tail endpoint. Set hasTail=true only when both landmarks are returned.
Set hasWings=true only for a bilateral pair of deformable wings attached to the torso or shoulder/back region. A horn, ear, tail, tail-tip flame, clothing flap, prop, or single unpaired shape is not a wing. For wings return left_wing_root, right_wing_root, left_wing_tip, and right_wing_tip. If all four credible landmarks cannot be supplied, set hasWings=false and return no wing landmarks. Do not invent extra landmarks.`;

function outputText(response) {
  for (const item of response?.output || []) for (const content of item?.content || []) {
    if (content?.type === "refusal") throw new Error("GPT could not analyze this model.");
    if (content?.type === "output_text" && typeof content.text === "string") return content.text;
  }
  if (typeof response?.output_text === "string") return response.output_text;
  throw new Error("GPT returned no anatomy result.");
}

export function validateAnatomyResult(value) {
  if (!value || !FAMILIES.includes(value.family) || !Array.isArray(value.landmarks)) throw new Error("GPT returned malformed anatomy data.");
  const seen = new Set();
  const landmarks = value.landmarks.filter((point) => {
    if (!LANDMARKS.includes(point?.name) || !VIEWS.includes(point?.view) || seen.has(point.name)) return false;
    seen.add(point.name);
    return [point.x, point.y, point.confidence].every(Number.isFinite);
  }).map((point) => ({ ...point, x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)), confidence: Math.max(0, Math.min(1, point.confidence)), visible: Boolean(point.visible), explanation: String(point.explanation || "") }));
  const names = new Set(landmarks.map((point) => point.name));
  const hasTail = Boolean(value.hasTail) && ["tail_base", "tail_tip"].every((name) => names.has(name));
  const wingNames = ["left_wing_root", "right_wing_root", "left_wing_tip", "right_wing_tip"];
  const hasWings = Boolean(value.hasWings) && wingNames.every((name) => names.has(name));
  const filteredLandmarks = landmarks.filter((point) => (hasTail || !point.name.startsWith("tail_")) && (hasWings || !point.name.includes("wing_")));
  return { family: value.family, species: String(value.species || "unknown creature"), hasTail, hasWings, confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)), explanation: String(value.explanation || ""), landmarks: filteredLandmarks };
}

export async function analyzeModelAnatomy(originalImages, renders, geometry, options = {}) {
  if (!Array.isArray(originalImages) || originalImages.length < 1 || originalImages.length > 3) throw new Error("GPT anatomy analysis requires one to three original images.");
  if (!Array.isArray(renders) || renders.length !== VIEWS.length || VIEWS.some((name) => !renders.some((render) => render?.name === name && typeof render?.dataUrl === "string"))) throw new Error("GPT anatomy analysis requires all six labeled GLB renders.");
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("GPT anatomy analysis is not configured.");
  const content = [{ type: "input_text", text: `Initial image-only anatomy profile: ${JSON.stringify(options.initialProfile || null)}\nGeometry summary: ${JSON.stringify(geometry)}\nThe original images come first, followed by six labeled GLB renders. Identify a known character or creature when possible and use that knowledge to guide interpretation, especially when separating anatomy from effects or accessories. Knowledge is a prior, not the final answer: preserve accurate findings from the initial profile, compare them with every source image, and let clear evidence from multiple GLB views determine the geometry Blender receives. Explain meaningful conflicts. Place all coordinates on the GLB renders only.` }];
  originalImages.forEach((imageUrl, index) => { content.push({ type: "input_text", text: `Original reference ${index + 1}:` }, { type: "input_image", image_url: imageUrl, detail: "high" }); });
  renders.forEach((render) => { content.push({ type: "input_text", text: `GLB render view=${render.name}:` }, { type: "input_image", image_url: render.dataUrl, detail: "high" }); });
  let response;
  try {
    response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: options.model || process.env.OPENAI_VISION_MODEL || "gpt-5.6-sol", store: false, input: [{ role: "system", content: ANATOMY_PROMPT }, { role: "user", content }], text: { format: { type: "json_schema", name: "desk_pal_model_anatomy", strict: true, schema: ANATOMY_SCHEMA } } }), signal: AbortSignal.timeout(180_000) });
  } catch (error) { throw new Error(`Could not reach GPT anatomy analysis: ${error?.message || String(error)}`); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `GPT anatomy analysis failed (${response.status}).`);
  try { return validateAnatomyResult(JSON.parse(outputText(payload))); }
  catch (error) { throw new Error(error instanceof SyntaxError ? "GPT returned invalid anatomy data." : error.message); }
}
