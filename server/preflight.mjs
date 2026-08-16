const ISSUE_TYPES = [
  "different_character",
  "inconsistent_appearance",
  "missing_anatomy",
  "conflicting_proportions",
  "duplicate_angle",
  "background_confusion",
  "hidden_limbs",
];

const ANGLES = ["front", "front_three_quarter", "left", "right", "back", "left_three_quarter", "right_three_quarter", "unknown"];
const RIG_FAMILIES = ["humanoid", "quadruped", "unsupported"];
const IMAGE_LANDMARKS = [
  "head", "chest", "pelvis", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_hand", "right_hand",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_foot", "right_foot",
  "front_left_shoulder", "front_right_shoulder", "front_left_elbow", "front_right_elbow", "front_left_paw", "front_right_paw",
  "back_left_hip", "back_right_hip", "back_left_knee", "back_right_knee", "back_left_paw", "back_right_paw",
  "tail_base", "tail_tip", "left_wing_root", "right_wing_root", "left_wing_tip", "right_wing_tip",
];

export const PREFLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer", minimum: 0, maximum: 2 },
          angle: { type: "string", enum: ANGLES },
          description: { type: "string" },
        },
        required: ["index", "angle", "description"],
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ISSUE_TYPES },
          imageIndexes: { type: "array", items: { type: "integer", minimum: 0, maximum: 2 } },
          explanation: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["type", "imageIndexes", "explanation", "suggestion"],
      },
    },
    anatomy: {
      type: "object", additionalProperties: false,
      properties: {
        family: { type: "string", enum: RIG_FAMILIES }, species: { type: "string" },
        hasTail: { type: "boolean" }, hasWings: { type: "boolean" }, confidence: { type: "number", minimum: 0, maximum: 1 }, explanation: { type: "string" },
        landmarks: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string", enum: IMAGE_LANDMARKS }, imageIndex: { type: "integer", minimum: 0, maximum: 2 },
              x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 },
              confidence: { type: "number", minimum: 0, maximum: 1 }, visible: { type: "boolean" }, explanation: { type: "string" },
            },
            required: ["name", "imageIndex", "x", "y", "confidence", "visible", "explanation"],
          },
        },
      }, required: ["family", "species", "hasTail", "hasWings", "confidence", "explanation", "landmarks"],
    },
  },
  required: ["summary", "images", "issues", "anatomy"],
};

const SYSTEM_PROMPT = `You are the image-quality gate for Desk Pal, an image-to-3D pet application. Inspect every supplied image carefully. The user may provide one to three views of the same character.

Report an issue only when it is reasonably evident. Check for exactly these failure modes:
1. Different characters accidentally uploaded.
2. Inconsistent clothing, colors, markings, accessories, or appearance between views.
3. Missing or cropped anatomy needed to reconstruct the character, including feet, a visible tail, or distinctive ears when the character appears to have them.
4. Conflicting body proportions between views.
5. Duplicate or nearly duplicate viewing angles that add no useful anatomical information.
6. Background objects, props, shadows, or other characters that could be mistaken for body parts.
7. Limbs that remain hidden, fused, crossed, or occluded in every supplied image.

Image 1 should be a front or three-quarter-front full-body view. Extra images should add a side and back/opposite-three-quarter view. All views must show the same character. Do not reject an intentional stylized design merely because it is unusual. Do not claim a body part is missing unless the other visual evidence indicates the character should have it. Explain each problem in plain language and give one concrete replacement-image instruction. Return no issues when the images are suitable for 3D generation and rigging.

Also create the initial anatomy plan before any 3D or Blender work. First identify the character, creature, or closest known design when possible. Use learned character/species knowledge as a strong prior that guides interpretation, but not as the final authority. Confirm it against the uploaded images, allow custom designs to differ, and explain important conflicts. Classify an upright two-leg/two-arm creature as humanoid and a four-load-bearing-limb creature as quadruped. Use unsupported only when neither template fits. Distinguish deformable anatomy from fire, glow, smoke, hair, clothing, props, and accessories. A tail-tip flame is an effect, not a wing. Use the character's anatomical left and right. Return the same canonical landmarks used for rigging, with coordinates on the clearest ORIGINAL image (x left-to-right, y top-to-bottom, normalized 0..1). Include all expected landmarks once and infer occluded joints using symmetry with lower confidence. Set hasTail=true only with tail_base and tail_tip. Set hasWings=true only for a bilateral pair of deformable wings attached to the torso/back, and then include left/right wing_root and wing_tip landmarks. A single unpaired shape cannot be a wing.`;

function outputText(response) {
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "refusal") throw new Error("The image quality check could not analyze these images.");
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  if (typeof response?.output_text === "string") return response.output_text;
  throw new Error("The image quality check returned no result.");
}

export function validatePreflightResult(value, imageCount) {
  if (!value || !Array.isArray(value.images) || !Array.isArray(value.issues) || !value.anatomy) throw new Error("The image quality result was malformed.");
  const reportedIndexes = value.images.map((image) => image?.index).filter(Number.isInteger);
  // GPT sees user-facing labels such as "Image 1" and may return one-based
  // indexes despite the schema. Accept both forms instead of blocking creation.
  const oneBased = reportedIndexes.length > 0 && !reportedIndexes.includes(0)
    && reportedIndexes.every((index) => index >= 1 && index <= imageCount)
    && (imageCount === 1 || reportedIndexes.includes(imageCount) || value.images.length === imageCount);
  const imageByIndex = new Map();
  for (const image of value.images) {
    const index = Number(image?.index) - (oneBased ? 1 : 0);
    if (!Number.isInteger(index) || index < 0 || index >= imageCount || !ANGLES.includes(image?.angle) || imageByIndex.has(index)) continue;
    imageByIndex.set(index, { index, angle: image.angle, description: String(image.description || "View analyzed") });
  }
  const images = Array.from({ length: imageCount }, (_, index) => imageByIndex.get(index) || ({ index, angle: "unknown", description: "View received; angle was not classified" }));
  const issues = value.issues
    .filter((issue) => ISSUE_TYPES.includes(issue?.type))
    .map((issue) => ({
      type: issue.type,
      imageIndexes: Array.isArray(issue.imageIndexes) ? issue.imageIndexes
        .map((index) => Number(index) - (oneBased ? 1 : 0))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < imageCount) : [],
      explanation: String(issue.explanation || "This image may not produce a reliable 3D pet."),
      suggestion: String(issue.suggestion || "Upload a clearer full-body view."),
    }));
  const anatomy = validateInitialAnatomy(value.anatomy, imageCount);
  return { passed: issues.length === 0, summary: String(value.summary || (issues.length ? "Please replace the highlighted images." : "Images are ready.")), images: images.sort((a, b) => a.index - b.index), issues, anatomy };
}

export function validateInitialAnatomy(value, imageCount = 3) {
  if (!value || !RIG_FAMILIES.includes(value.family) || !Array.isArray(value.landmarks)) throw new Error("The initial anatomy profile was malformed.");
  const seen = new Set();
  const landmarks = value.landmarks.filter((point) => {
    if (!IMAGE_LANDMARKS.includes(point?.name) || seen.has(point.name)) return false;
    seen.add(point.name);
    return [point.imageIndex, point.x, point.y, point.confidence].every(Number.isFinite);
  }).map((point) => ({
    name: point.name, imageIndex: Math.max(0, Math.min(imageCount - 1, Math.trunc(point.imageIndex))),
    x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)), confidence: Math.max(0, Math.min(1, point.confidence)),
    visible: Boolean(point.visible), explanation: String(point.explanation || ""),
  }));
  const names = new Set(landmarks.map((point) => point.name));
  const hasTail = Boolean(value.hasTail) && ["tail_base", "tail_tip"].every((name) => names.has(name));
  const wingNames = ["left_wing_root", "right_wing_root", "left_wing_tip", "right_wing_tip"];
  const hasWings = Boolean(value.hasWings) && wingNames.every((name) => names.has(name));
  const filteredLandmarks = landmarks.filter((point) => (hasTail || !point.name.startsWith("tail_")) && (hasWings || !point.name.includes("wing_")));
  return { family: value.family, species: String(value.species || "unknown creature"), hasTail, hasWings, confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)), explanation: String(value.explanation || ""), landmarks: filteredLandmarks };
}

export async function analyzeImagePreflight(dataUrls, options = {}) {
  if (!Array.isArray(dataUrls) || dataUrls.length < 1 || dataUrls.length > 3) throw new Error("Choose between one and three images.");
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("The GPT image-quality check is not configured.");
  const fetchImpl = options.fetchImpl || fetch;
  const model = options.model || process.env.OPENAI_VISION_MODEL || "gpt-5.6-sol";
  const content = [{ type: "input_text", text: `Analyze these ${dataUrls.length} numbered character image${dataUrls.length === 1 ? "" : "s"}. Return one images entry for every supplied image. In the structured index fields use zero-based indexes: Image 1 is index 0, Image 2 is index 1, and Image 3 is index 2. Return all detected problems before any paid 3D generation begins.` }];
  dataUrls.forEach((imageUrl, index) => {
    content.push({ type: "input_text", text: `Image ${index + 1}:` });
    content.push({ type: "input_image", image_url: imageUrl, detail: "high" });
  });
  let response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        input: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content }],
        text: { format: { type: "json_schema", name: "desk_pal_image_preflight", strict: true, schema: PREFLIGHT_SCHEMA } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(`Could not reach the GPT image-quality check: ${error?.message || String(error)}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `GPT image-quality check failed (${response.status}).`);
  let parsed;
  try { parsed = JSON.parse(outputText(payload)); }
  catch (error) { throw new Error(error instanceof SyntaxError ? "The image quality check returned invalid data." : error.message); }
  return validatePreflightResult(parsed, dataUrls.length);
}
