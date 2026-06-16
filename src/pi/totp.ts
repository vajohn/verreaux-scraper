// RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits). Importable twin of
// scripts/totp.mjs (which keeps the `gen`/`now`/`verify` CLI).
import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, atMs: number, step = 30, digits = 6): string {
  const key = base32Decode(secretBase32);
  let counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  atMs: number,
  step = 30,
  digits = 6,
): boolean {
  const c = String(code).trim();
  if (c.length !== digits) return false;
  for (const drift of [-1, 0, 1]) {
    if (totp(secretBase32, atMs + drift * step * 1000, step, digits) === c) return true;
  }
  return false;
}
