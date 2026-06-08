import { describe, it, expect } from "vitest";
// RFC 6238 reference: ASCII secret "12345678901234567890" in base32.
import { totp, verifyTotp } from "../scripts/totp.mjs";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp (RFC 6238 SHA-1, 6 digits)", () => {
  it("matches the RFC 6238 test vector at T=59s", () => {
    expect(totp(SECRET, 59_000)).toBe("287082");
  });
  it("verifyTotp accepts the correct code and rejects a wrong one", () => {
    expect(verifyTotp(SECRET, "287082", 59_000)).toBe(true);
    expect(verifyTotp(SECRET, "000000", 59_000)).toBe(false);
  });
  it("verifyTotp tolerates +/- one 30s step of clock drift", () => {
    expect(verifyTotp(SECRET, "287082", 84_000)).toBe(true);
  });
});
