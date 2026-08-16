import { describe, expect, it, vi } from "vitest";
import { analyzeImagePreflight, validateInitialAnatomy, validatePreflightResult } from "./preflight.mjs";

const imagePoint = (name, x, y) => ({ name, imageIndex: 0, x, y, confidence: 0.9, visible: true, explanation: "Clear" });
const anatomy = { family: "humanoid", species: "stylized creature", hasTail: true, hasWings: false, confidence: 0.9, explanation: "Upright biped", landmarks: [imagePoint("head", 0.5, 0.1), imagePoint("tail_base", 0.6, 0.65), imagePoint("tail_tip", 0.85, 0.55)] };

describe("image preflight", () => {
  it("blocks generation and preserves actionable issues", () => {
    const result = validatePreflightResult({ summary: "Replace one image.", images: [{ index: 0, angle: "front", description: "Front" }], issues: [{ type: "hidden_limbs", imageIndexes: [0], explanation: "Both hands are hidden.", suggestion: "Upload a view with both hands visible." }], anatomy }, 1);
    expect(result.passed).toBe(false);
    expect(result.issues[0].suggestion).toMatch(/hands visible/);
  });

  it("sends images with a strict structured-output schema", async () => {
    const fetchImpl = vi.fn(async (_url, request) => {
      const body = JSON.parse(request.body);
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
      expect(body.input[1].content.filter((item) => item.type === "input_image")).toHaveLength(2);
      return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Ready", images: [{ index: 0, angle: "front", description: "Front" }, { index: 1, angle: "left", description: "Left" }], issues: [], anatomy }) }] }] }) };
    });
    const result = await analyzeImagePreflight(["data:image/png;base64,AA==", "data:image/png;base64,AA=="], { apiKey: "test", model: "test-model", fetchImpl });
    expect(result.passed).toBe(true);
    expect(result.anatomy).toMatchObject({ family: "humanoid", hasTail: true, hasWings: false });
  });

  it("normalizes a one-based image index", () => {
    const result = validatePreflightResult({ summary: "Ready", images: [{ index: 1, angle: "front", description: "Front" }], issues: [], anatomy }, 1);
    expect(result.images).toEqual([{ index: 0, angle: "front", description: "Front" }]);
  });

  it("fills a missing classification without discarding quality issues", () => {
    const result = validatePreflightResult({ summary: "Needs another view", images: [{ index: 0, angle: "front", description: "Front" }], issues: [{ type: "hidden_limbs", imageIndexes: [0], explanation: "A hand is hidden.", suggestion: "Show both hands." }], anatomy }, 2);
    expect(result.images).toHaveLength(2);
    expect(result.images[1]).toMatchObject({ index: 1, angle: "unknown" });
    expect(result.passed).toBe(false);
  });

  it("keeps one validated copy of each image landmark", () => {
    const value = validateInitialAnatomy({
      ...anatomy,
      confidence: 2,
      landmarks: [
        anatomy.landmarks[0],
        { ...anatomy.landmarks[0], x: 0.9 },
        { name: "not_a_joint", imageIndex: 0, x: 0.5, y: 0.5, confidence: 1, visible: true, explanation: "Invalid" },
      ],
    }, 1);
    expect(value.confidence).toBe(1);
    expect(value.landmarks).toEqual([anatomy.landmarks[0]]);
    expect(value.hasTail).toBe(false);
  });

  it("does not pass an isolated effect shape through as wings", () => {
    const value = validateInitialAnatomy({ ...anatomy, hasWings: true, landmarks: [...anatomy.landmarks, imagePoint("left_wing_tip", 0.8, 0.4)] }, 1);
    expect(value.hasWings).toBe(false);
    expect(value.landmarks.some((point) => point.name.includes("wing"))).toBe(false);
  });
});
