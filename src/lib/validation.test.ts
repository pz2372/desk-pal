import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, validateImage } from "./validation";

describe("validateImage", () => {
  it("accepts a supported image", () => expect(validateImage({ type: "image/png", size: 1024 })).toBeNull());
  it("rejects unsupported content", () => expect(validateImage({ type: "image/gif", size: 1024 })).toMatch(/PNG/));
  it("rejects oversized content", () => expect(validateImage({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 })).toMatch(/20 MB/));
});
