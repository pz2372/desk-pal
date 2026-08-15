import { describe, expect, it } from "vitest";
import { createRigAnalysis, mergeSmartRigAnalysis, validateBlenderGuide, validateRigCorrections } from "./rigging.mjs";

describe("rig guide templates", () => {
  it("creates a quadruped guide with an optional tail", () => {
    const guide = createRigAnalysis("quadruped", false, { hasTail: true });
    expect(guide.family).toBe("quadruped");
    expect(guide.anatomy.legs).toBe(4);
    expect(guide.landmarks.some((landmark) => landmark.name === "tail_tip")).toBe(true);
  });

  it("rejects incomplete user corrections", () => {
    expect(() => validateRigCorrections({ family: "humanoid", landmarks: [] })).toThrow(/top of head/i);
  });

  it("does not silently treat unsupported bodies as humanoids", () => {
    expect(() => createRigAnalysis("avian", false)).toThrow(/humanoid and quadruped/i);
  });

  it("accepts every required humanoid correction", () => {
    const guide = createRigAnalysis("biped", false);
    const corrected = validateRigCorrections({ family: "humanoid", landmarks: guide.landmarks.map(({ name }) => ({ name, position: [0, 1, 0] })) });
    expect(corrected.status).toBe("corrected");
    expect(corrected.landmarks.every((landmark) => landmark.source === "user")).toBe(true);
  });

  it("accepts a complete high-confidence GPT projection", () => {
    const guide = createRigAnalysis("biped", false);
    const landmarks = guide.landmarks.map(({ name }) => ({ name, visible: true, confidence: 0.9 }));
    const projected = { landmarks: guide.landmarks.map(({ name }, index) => ({ name, position: [index / 10, 1, 0] })) };
    expect(mergeSmartRigAnalysis({ family: "humanoid", landmarks }, projected).status).toBe("corrected");
  });

  it("asks for correction when GPT confidence is low", () => {
    const guide = createRigAnalysis("biped", false);
    const landmarks = guide.landmarks.map(({ name }) => ({ name, visible: true, confidence: name === "left_hand" ? 0.4 : 0.9 }));
    const projected = { landmarks: guide.landmarks.map(({ name }) => ({ name, position: [0, 1, 0] })) };
    const merged = mergeSmartRigAnalysis({ family: "humanoid", landmarks }, projected);
    expect(merged.status).toBe("needs_correction");
    expect(merged.landmarks.find((point) => point.name === "left_hand").position).toBeUndefined();
  });

  it("fills secondary humanoid joints from reliable core anchors", () => {
    const core = ["head", "pelvis", "left_hand", "right_hand", "left_foot", "right_foot"];
    const vision = { family: "humanoid", landmarks: core.map((name) => ({ name, visible: true, confidence: 0.9 })) };
    const projected = { landmarks: core.map((name, index) => ({ name, position: [index - 2.5, 3 - index / 2, 0] })) };
    const merged = mergeSmartRigAnalysis(vision, projected);
    expect(merged.status).toBe("corrected");
    expect(merged.landmarks.find((point) => point.name === "left_elbow").position).toHaveLength(3);
    expect(() => validateBlenderGuide(merged)).not.toThrow();
  });

  it("rejects an incomplete guide before Blender starts", () => {
    const guide = createRigAnalysis("biped", false);
    expect(() => validateBlenderGuide(guide)).toThrow(/missing top of head/i);
  });
});
