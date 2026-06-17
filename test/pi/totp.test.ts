import { describe, it, expect } from "vitest";
import { totp, verifyTotp } from "../../src/pi/totp.js";

const SECRET = "JBSWY3DPEHPK3PXP";

describe("totp", () => {
  it("verifies the code it generates for the same instant", () => {
    const at = 1_700_000_000_000;
    const code = totp(SECRET, at);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(SECRET, code, at)).toBe(true);
  });

  it("accepts a code from the adjacent 30s window (clock drift)", () => {
    const at = 1_700_000_000_000;
    const prev = totp(SECRET, at - 30_000);
    expect(verifyTotp(SECRET, prev, at)).toBe(true);
  });

  it("rejects a wrong code", () => {
    expect(verifyTotp(SECRET, "000000", 1_700_000_000_000)).toBe(false);
  });

  it("rejects a code of the wrong length", () => {
    expect(verifyTotp(SECRET, "12345", 1_700_000_000_000)).toBe(false);
  });

  it("honors a custom step size in both generate and verify", () => {
    const at = 1_700_000_000_000;
    const code = totp(SECRET, at, 60);
    expect(verifyTotp(SECRET, code, at, 60)).toBe(true);
  });
});
