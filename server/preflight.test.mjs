import { describe, expect, it, vi } from "vitest";
import { analyzeImagePreflight, validatePreflightResult } from "./preflight.mjs";

describe("image preflight", () => {
  it("blocks generation and preserves actionable issues", () => {
    const result = validatePreflightResult({ summary: "Replace one image.", images: [{ index: 0, angle: "front", description: "Front" }], issues: [{ type: "hidden_limbs", imageIndexes: [0], explanation: "Both hands are hidden.", suggestion: "Upload a view with both hands visible." }] }, 1);
    expect(result.passed).toBe(false);
    expect(result.issues[0].suggestion).toMatch(/hands visible/);
  });

  it("sends images with a strict structured-output schema", async () => {
    const fetchImpl = vi.fn(async (_url, request) => {
      const body = JSON.parse(request.body);
      expect(body.store).toBe(false);
      expect(body.text.format.strict).toBe(true);
      expect(body.input[1].content.filter((item) => item.type === "input_image")).toHaveLength(2);
      return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Ready", images: [{ index: 0, angle: "front", description: "Front" }, { index: 1, angle: "left", description: "Left" }], issues: [] }) }] }] }) };
    });
    const result = await analyzeImagePreflight(["data:image/png;base64,AA==", "data:image/png;base64,AA=="], { apiKey: "test", model: "test-model", fetchImpl });
    expect(result.passed).toBe(true);
  });
});
