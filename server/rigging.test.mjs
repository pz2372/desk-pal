import { describe, expect, it } from "vitest";
import { createRigAnalysis, validateRigCorrections } from "./rigging.mjs";

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
});
