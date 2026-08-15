import { describe, expect, it } from "vitest";
import { createCorrectionGuide, firstMissingLandmark } from "./rigging";

describe("rig correction guides", () => {
  it("keeps compatible points when optional tail points are added", () => {
    const first = createCorrectionGuide(undefined, "humanoid", false, false);
    first.landmarks[0].position = [0, 1, 0];
    const next = createCorrectionGuide(first, "humanoid", true, false);
    expect(next.landmarks[0].position).toEqual([0, 1, 0]);
    expect(next.landmarks.at(-1)?.name).toBe("tail_tip");
  });

  it("reports the first point that still needs a click", () => {
    const guide = createCorrectionGuide(undefined, "quadruped", false, false);
    expect(firstMissingLandmark(guide)?.name).toBe("head");
  });
});
