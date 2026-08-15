const FAMILIES = ["humanoid", "quadruped", "unsupported"];
const VIEWS = ["front", "front_left", "left", "back", "right", "front_right"];
const LANDMARKS = [
  "head", "chest", "pelvis",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_foot", "right_foot",
  "front_left_shoulder", "front_right_shoulder", "front_left_elbow", "front_right_elbow", "front_left_paw", "front_right_paw",
  "back_left_hip", "back_right_hip", "back_left_knee", "back_right_knee", "back_left_paw", "back_right_paw",
  "tail_base", "tail_tip", "left_wing_tip", "right_wing_tip",
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

const PROMPT = `You are Desk Pal's anatomical landmark detector. Analyze neutral renders of a completed, unrigged GLB, using the original character images only as semantic references.

Choose humanoid only for an upright two-leg/two-arm skeleton, quadruped for four load-bearing limbs, or unsupported otherwise. Use the character's own left and right. Coordinates refer to a supplied GLB render: x runs left-to-right and y top-to-bottom, both normalized 0..1. Select the view where each joint is clearest and put the point at the anatomical joint center inside the visible form, not merely on its silhouette.

For humanoids return exactly: head, pelvis, left/right shoulder, elbow, hand, hip, knee, and foot. For quadrupeds return exactly: head, chest, pelvis, front left/right shoulder, elbow, paw, and back left/right hip, knee, paw. Add tail_base and tail_tip when a tail exists. Add left_wing_tip and right_wing_tip when wings exist. Every required point must appear once. When occluded, infer a best coordinate using symmetry and other views, but set visible false and lower confidence. Do not invent extra landmarks.`;

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
  return { family: value.family, species: String(value.species || "unknown creature"), hasTail: Boolean(value.hasTail), hasWings: Boolean(value.hasWings), confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)), explanation: String(value.explanation || ""), landmarks };
}

export async function analyzeModelAnatomy(originalImages, renders, geometry, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("GPT anatomy analysis is not configured.");
  const content = [{ type: "input_text", text: `Geometry summary: ${JSON.stringify(geometry)}\nThe original images come first, followed by six labeled GLB renders. Place all coordinates on the GLB renders only.` }];
  originalImages.forEach((imageUrl, index) => { content.push({ type: "input_text", text: `Original reference ${index + 1}:` }, { type: "input_image", image_url: imageUrl, detail: "high" }); });
  renders.forEach((render) => { content.push({ type: "input_text", text: `GLB render view=${render.name}:` }, { type: "input_image", image_url: render.dataUrl, detail: "high" }); });
  let response;
  try {
    response = await (options.fetchImpl || fetch)("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: options.model || process.env.OPENAI_VISION_MODEL || "gpt-5.6-sol", store: false, input: [{ role: "system", content: PROMPT }, { role: "user", content }], text: { format: { type: "json_schema", name: "desk_pal_model_anatomy", strict: true, schema: ANATOMY_SCHEMA } } }), signal: AbortSignal.timeout(180_000) });
  } catch (error) { throw new Error(`Could not reach GPT anatomy analysis: ${error?.message || String(error)}`); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `GPT anatomy analysis failed (${response.status}).`);
  try { return validateAnatomyResult(JSON.parse(outputText(payload))); }
  catch (error) { throw new Error(error instanceof SyntaxError ? "GPT returned invalid anatomy data." : error.message); }
}
