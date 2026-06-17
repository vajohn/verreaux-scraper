import { describe, it, expect } from "vitest";
import { hashPasscode, verifyPasscode } from "../../src/pi/passwords.js";

describe("passwords", () => {
  it("verifies a correct passcode and rejects a wrong one", () => {
    const h = hashPasscode("hunter2");
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPasscode("hunter2", h)).toBe(true);
    expect(verifyPasscode("wrong", h)).toBe(false);
  });

  it("produces a different salt/hash each time for the same input", () => {
    expect(hashPasscode("same")).not.toBe(hashPasscode("same"));
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(verifyPasscode("x", "not-a-valid-hash")).toBe(false);
  });
});
