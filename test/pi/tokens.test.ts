import { describe, it, expect } from "vitest";
import { newToken, hashToken, verifyTokenHash } from "../../src/pi/tokens.js";

describe("tokens", () => {
  it("generates a random token and verifies its hash", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(t);
    expect(verifyTokenHash(t, h)).toBe(true);
    expect(verifyTokenHash(newToken(), h)).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(verifyTokenHash(newToken(), "nope")).toBe(false);
  });
});
