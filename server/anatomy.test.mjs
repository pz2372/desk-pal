import { describe, expect, it, vi } from "vitest";
import { analyzeModelAnatomy, ANATOMY_PROMPT, validateAnatomyResult } from "./anatomy.mjs";

const result = {
  family: "humanoid", species: "stylized character", hasTail: false, hasWings: false,
  confidence: 0.91, explanation: "Clear upright anatomy",
  landmarks: [{ name: "head", view: "front", x: 0.5, y: 0.12, confidence: 0.95, visible: true, explanation: "Clear" }],
};

describe("GPT model anatomy", () => {
  it("sends references and labeled GLB renders with strict structured output", async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }), request: JSON.parse(options.body) }));
    const renders = ["front", "front_left", "left", "back", "right", "front_right"].map((name) => ({ name, dataUrl: "data:image/png;base64,AAAA" }));
    const value = await analyzeModelAnatomy(["data:image/png;base64,AAAA"], renders, { meshCount: 1 }, { apiKey: "test", fetchImpl, initialProfile: { family: "humanoid", hasTail: true, hasWings: false } });
    expect(value.family).toBe("humanoid");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.input[1].content.filter((item) => item.type === "input_image")).toHaveLength(7);
    expect(body.input[0].content).toContain("Every returned x/y coordinate MUST refer to one labeled GLB render");
    expect(body.input[1].content[0].text).toContain('"family":"humanoid"');
    expect(ANATOMY_PROMPT).toContain("strong anatomical prior");
    expect(ANATOMY_PROMPT).toContain("tail-tip flame");
  });

  it("deduplicates and clamps landmark results", () => {
    const value = validateAnatomyResult({ ...result, landmarks: [result.landmarks[0], { ...result.landmarks[0], x: 2 }] });
    expect(value.landmarks).toHaveLength(1);
  });

  it("rejects a wing classification without paired roots and tips", () => {
    const value = validateAnatomyResult({
      ...result,
      hasWings: true,
      landmarks: [...result.landmarks, { name: "left_wing_tip", view: "front", x: 0.8, y: 0.3, confidence: 0.9, visible: true, explanation: "Bright appendage" }],
    });
    expect(value.hasWings).toBe(false);
    expect(value.landmarks.some((point) => point.name.includes("wing"))).toBe(false);
  });

  it("keeps wings only with bilateral attachment evidence", () => {
    const wings = ["left_wing_root", "right_wing_root", "left_wing_tip", "right_wing_tip"].map((name, index) => ({ name, view: "back", x: 0.3 + index * 0.1, y: 0.4, confidence: 0.9, visible: true, explanation: "Paired torso-attached wing" }));
    const value = validateAnatomyResult({ ...result, hasWings: true, landmarks: [...result.landmarks, ...wings] });
    expect(value.hasWings).toBe(true);
  });

  it("refuses to analyze an incomplete render set", async () => {
    await expect(analyzeModelAnatomy(["data:image/png;base64,AAAA"], [{ name: "front", dataUrl: "data:image/png;base64,AAAA" }], {}, { apiKey: "test" })).rejects.toThrow(/six labeled GLB renders/i);
  });
});
