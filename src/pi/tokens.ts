import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh opaque device token (plaintext, given to the device once). */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** sha256(token) hex — what we store server-side. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyTokenHash(token: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
