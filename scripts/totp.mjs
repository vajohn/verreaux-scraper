// ---------------------------------------------------------------------------
// totp.mjs — RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits). No external deps.
//
// Library exports: totp(secretBase32, atMs?), verifyTotp(secretBase32, code, atMs?).
// CLI:
//   node scripts/totp.mjs gen            -> print a fresh secret + otpauth URI
//   node scripts/totp.mjs now            -> print current code (reads SCRAPE_TOTP_SECRET)
//   node scripts/totp.mjs verify <code>  -> exit 0 if valid else 1 (reads SCRAPE_TOTP_SECRET)
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secretBase32, atMs = Date.now(), step = 30, digits = 6) {
  const key = base32Decode(secretBase32);
  let counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

export function verifyTotp(secretBase32, code, atMs = Date.now()) {
  const c = String(code).trim();
  for (const drift of [-1, 0, 1]) {
    if (totp(secretBase32, atMs + drift * 30_000) === c) return true;
  }
  return false;
}

function genSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = 0, value = 0, s = "";
  for (const x of bytes) {
    value = (value << 8) | x; bits += 8;
    while (bits >= 5) { s += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return s;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, arg] = process.argv;
  if (cmd === "gen") {
    const secret = genSecret();
    console.log("secret:", secret);
    console.log(
      `otpauth://totp/verreaux-scrape?secret=${secret}&issuer=verreaux-scraper&period=30&digits=6`,
    );
    process.exit(0);
  }
  const secret = process.env.SCRAPE_TOTP_SECRET;
  if (!secret) { console.error("SCRAPE_TOTP_SECRET not set"); process.exit(2); }
  if (cmd === "now") {
    console.log(totp(secret));
    process.exit(0);
  }
  if (cmd === "verify") {
    process.exit(verifyTotp(secret, arg ?? "") ? 0 : 1);
  }
  console.error("usage: totp.mjs gen | now | verify <code>");
  process.exit(2);
}
