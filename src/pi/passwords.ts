import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;
// Pin scrypt cost params so a future change to Node's defaults can't make
// previously-stored hashes unverifiable.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

/** Returns "saltHex:hashHex". */
export function hashPasscode(passcode: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passcode, salt, KEYLEN, SCRYPT);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(passcode, salt, KEYLEN, SCRYPT);
  return timingSafeEqual(actual, expected);
}
