import { describe, expect, it, vi } from "vitest";
import { analyzeModelAnatomy, validateAnatomyResult } from "./anatomy.mjs";

const result = {
  family: "humanoid", species: "stylized character", hasTail: false, hasWings: false,
  confidence: 0.91, explanation: "Clear upright anatomy",
  landmarks: [{ name: "head", view: "front", x: 0.5, y: 0.12, confidence: 0.95, visible: true, explanation: "Clear" }],
};

describe("GPT model anatomy", () => {
  it("sends references and labeled GLB renders with strict structured output", async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({ ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }), request: JSON.parse(options.body) }));
    const renders = ["front", "front_left", "left", "back", "right", "front_right"].map((name) => ({ name, dataUrl: "data:image/png;base64,AAAA" }));
    const value = await analyzeModelAnatomy(["data:image/png;base64,AAAA"], renders, { meshCount: 1 }, { apiKey: "test", fetchImpl });
    expect(value.family).toBe("humanoid");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true);
    expect(body.input[1].content.filter((item) => item.type === "input_image")).toHaveLength(7);
  });

  it("deduplicates and clamps landmark results", () => {
    const value = validateAnatomyResult({ ...result, landmarks: [result.landmarks[0], { ...result.landmarks[0], x: 2 }] });
    expect(value.landmarks).toHaveLength(1);
  });
});
