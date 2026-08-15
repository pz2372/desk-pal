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
  },
  required: ["summary", "images", "issues"],
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

Image 1 should be a front or three-quarter-front full-body view. Extra images should add a side and back/opposite-three-quarter view. All views must show the same character. Do not reject an intentional stylized design merely because it is unusual. Do not claim a body part is missing unless the other visual evidence indicates the character should have it. Explain each problem in plain language and give one concrete replacement-image instruction. Return no issues when the images are suitable for 3D generation and rigging.`;

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
  if (!value || !Array.isArray(value.images) || !Array.isArray(value.issues)) throw new Error("The image quality result was malformed.");
  const images = value.images
    .filter((image) => Number.isInteger(image?.index) && image.index >= 0 && image.index < imageCount && ANGLES.includes(image.angle))
    .map((image) => ({ index: image.index, angle: image.angle, description: String(image.description || "View analyzed") }));
  if (images.length !== imageCount || new Set(images.map((image) => image.index)).size !== imageCount) throw new Error("The image quality result did not classify every image.");
  const issues = value.issues
    .filter((issue) => ISSUE_TYPES.includes(issue?.type))
    .map((issue) => ({
      type: issue.type,
      imageIndexes: Array.isArray(issue.imageIndexes) ? issue.imageIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < imageCount) : [],
      explanation: String(issue.explanation || "This image may not produce a reliable 3D pet."),
      suggestion: String(issue.suggestion || "Upload a clearer full-body view."),
    }));
  return { passed: issues.length === 0, summary: String(value.summary || (issues.length ? "Please replace the highlighted images." : "Images are ready.")), images: images.sort((a, b) => a.index - b.index), issues };
}

export async function analyzeImagePreflight(dataUrls, options = {}) {
  if (!Array.isArray(dataUrls) || dataUrls.length < 1 || dataUrls.length > 3) throw new Error("Choose between one and three images.");
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("The GPT image-quality check is not configured.");
  const fetchImpl = options.fetchImpl || fetch;
  const model = options.model || process.env.OPENAI_VISION_MODEL || "gpt-5.6-sol";
  const content = [{ type: "input_text", text: `Analyze these ${dataUrls.length} numbered character image${dataUrls.length === 1 ? "" : "s"}. Return all detected problems before any paid 3D generation begins.` }];
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
