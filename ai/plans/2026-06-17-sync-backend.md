# Multi-device Sync — Pi Backend Implementation Plan (Spec 1, Part 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account + device-registry + reading-position sync to the Pi `api` service, backed by a new Postgres sidecar, so the PWA can sync reading positions across a user's devices.

**Architecture:** A pure merge function is the heart (furthest-position-wins with owning-device regression). A `AccountStore` interface decouples handler logic from storage: an `InMemoryAccountStore` makes handlers fully unit-testable in-sandbox; a `PgAccountStore` (thin SQL over `pg`) runs on the Pi. New endpoints (`/enroll`, `/sync/position`, `/sync/positions`) are added to the existing `handleApiRequest`. Enrollment is gated by the existing shared TOTP; routine syncs use a per-device bearer token.

**Tech Stack:** Node 22 / TypeScript (ESM, NodeNext), vitest, `pg`, `node:crypto` (scrypt + sha256), Docker compose (+ postgres), the existing Node-`http` `api` service.

**Spec:** `../../../verreaux-app/ai/specs/2026-06-17-multidevice-sync-design.md` (lives in the `verreaux` app repo; this plan implements its Pi-backend half).

**Scope:** Backend only (this repo, `verreaux-scraper`). The PWA client (`accountClient`, `positionSync`, Settings UI, push/pull reconcile) is **Part 2**, a separate plan in the `verreaux` repo. Cross-device **download sharing is Spec 2** (out of scope entirely).

> **➡️ When this plan is implemented and the Pi has the Postgres stack running, continue to Part 2 (PWA sync client)** in the `verreaux` repo: `ai/plans/2026-06-17-sync-pwa-client.md`. Part 2 depends on this plan's `/enroll` + `/sync/*` API contract.

---

## File Structure

**New, pure/testable (`src/pi/`):**
- `src/pi/positionMerge.ts` — `Position`, `StoredPosition`, `mergePosition()` (the conflict rule).
- `src/pi/passwords.ts` — `hashPasscode()`, `verifyPasscode()` (scrypt).
- `src/pi/tokens.ts` — `newToken()`, `hashToken()`, `verifyTokenHash()`.
- `src/pi/syncStore.ts` — `Account`, `Device`, `AccountStore` interface, `InMemoryAccountStore`.
- `src/pi/syncHandlers.ts` — `handleEnroll`, `resolveDevice`, `handlePutPosition`, `handleGetPositions` (pure-ish; take a store + deps, return `{status, body}`).

**New, infra (`src/pi/` + repo root):**
- `src/pi/pgStore.ts` — `PgAccountStore implements AccountStore` (thin SQL) + `SCHEMA_SQL`.

**Modified:**
- `src/pi/api.ts` — extend `ApiDeps` with `store` + `newToken`; add `/enroll`, `/sync/position`, `/sync/positions` routes + a bearer-token helper.
- `scripts/pi-api.mjs` — construct `PgAccountStore` from `DATABASE_URL`, run schema, pass to deps.
- `docker-compose.yml` — add a `postgres` service; give `api` `DATABASE_URL` + `depends_on`.
- `package.json` — add `pg` (+ `@types/pg`).

**New tests (`test/pi/`):** `positionMerge.test.ts`, `passwords.test.ts`, `tokens.test.ts`, `syncStore.test.ts`, `syncHandlers.test.ts`, plus sync-route cases appended to `test/pi/api.test.ts`.

---

## Task 1: Position merge (the conflict rule)

**Files:** Create `src/pi/positionMerge.ts`; Test `test/pi/positionMerge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/positionMerge.test.ts
import { describe, it, expect } from "vitest";
import { mergePosition, type StoredPosition } from "../../src/pi/positionMerge.js";

const pos = (chapterOrder: number, pageIndex: number, ownerDevice = "d1", manuallyMarked = false): StoredPosition =>
  ({ chapterOrder, pageIndex, ownerDevice, manuallyMarked });

describe("mergePosition", () => {
  it("adopts incoming when there is no current", () => {
    const r = mergePosition(null, { chapterOrder: 12, pageIndex: 3, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ chapterOrder: 12, pageIndex: 3, ownerDevice: "d2", manuallyMarked: false });
  });

  it("keeps the further position when a behind, non-owner device syncs (device-1 p1 vs device-2 p21)", () => {
    const current = pos(12, 21, "d2");
    const r = mergePosition(current, { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d1" });
    expect(r.changed).toBe(false);
    expect(r.value).toEqual(current);
  });

  it("accepts a regression from the owning device (device-2 goes back to p1)", () => {
    const current = pos(12, 21, "d2");
    const r = mergePosition(current, { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ chapterOrder: 12, pageIndex: 1, ownerDevice: "d2", manuallyMarked: false });
  });

  it("adopts a further position from either device (p25 wins)", () => {
    expect(mergePosition(pos(12, 21, "d2"), { chapterOrder: 12, pageIndex: 25, manuallyMarked: false, device: "d1" }).value)
      .toEqual({ chapterOrder: 12, pageIndex: 25, ownerDevice: "d1", manuallyMarked: false });
  });

  it("orders by chapter first, then page", () => {
    // ch13 p1 is further than ch12 p99
    expect(mergePosition(pos(12, 99, "d2"), { chapterOrder: 13, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(true);
    // ch11 p1 is behind ch12 p99 -> non-owner ignored
    expect(mergePosition(pos(12, 99, "d2"), { chapterOrder: 11, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(false);
  });

  it("handles fractional chapter orders", () => {
    expect(mergePosition(pos(12, 1, "d2"), { chapterOrder: 12.5, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(true);
  });

  it("treats an equal position as no change", () => {
    expect(mergePosition(pos(12, 5, "d2"), { chapterOrder: 12, pageIndex: 5, manuallyMarked: false, device: "d1" }).changed).toBe(false);
  });

  it("carries manuallyMarked with an adopted value", () => {
    expect(mergePosition(pos(1, 0, "d2"), { chapterOrder: 5, pageIndex: 0, manuallyMarked: true, device: "d1" }).value.manuallyMarked).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/positionMerge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/positionMerge.ts
export interface Position {
  chapterOrder: number;
  pageIndex: number;
  manuallyMarked: boolean;
}

export interface StoredPosition extends Position {
  /** Device id that set the current value (drives the regression rule). */
  ownerDevice: string;
}

export interface MergeResult {
  changed: boolean;
  value: StoredPosition;
}

/** -1 / 0 / 1 comparing (chapterOrder, then pageIndex). */
function cmp(a: Position, b: Position): number {
  if (a.chapterOrder !== b.chapterOrder) return a.chapterOrder < b.chapterOrder ? -1 : 1;
  if (a.pageIndex !== b.pageIndex) return a.pageIndex < b.pageIndex ? -1 : 1;
  return 0;
}

/**
 * Furthest position wins; a deliberate regression is honored only from the
 * device that owns the current value. See the spec's merge rules.
 */
export function mergePosition(
  current: StoredPosition | null,
  incoming: Position & { device: string },
): MergeResult {
  const adopted: StoredPosition = {
    chapterOrder: incoming.chapterOrder,
    pageIndex: incoming.pageIndex,
    manuallyMarked: incoming.manuallyMarked,
    ownerDevice: incoming.device,
  };
  if (!current) return { changed: true, value: adopted };

  const c = cmp(incoming, current);
  if (c > 0) return { changed: true, value: adopted }; // further -> adopt
  if (c < 0 && incoming.device === current.ownerDevice) return { changed: true, value: adopted }; // owner regression
  return { changed: false, value: current }; // behind non-owner, or tie
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/positionMerge.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/positionMerge.ts test/pi/positionMerge.test.ts
git commit -m "feat(sync): position merge — furthest-wins + owning-device regression"
```

---

## Task 2: Passcode hashing (scrypt)

**Files:** Create `src/pi/passwords.ts`; Test `test/pi/passwords.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/passwords.test.ts
import { describe, it, expect } from "vitest";
import { hashPasscode, verifyPasscode } from "../../src/pi/passwords.js";

describe("passwords", () => {
  it("verifies a correct passcode and rejects a wrong one", () => {
    const h = hashPasscode("hunter2");
    expect(h).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // salt:hash hex
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/passwords.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/passwords.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;

/** Returns "saltHex:hashHex". */
export function hashPasscode(passcode: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passcode, salt, KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPasscode(passcode: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
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
  const actual = scryptSync(passcode, salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/passwords.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/passwords.ts test/pi/passwords.test.ts
git commit -m "feat(sync): scrypt passcode hashing"
```

---

## Task 3: Device tokens

**Files:** Create `src/pi/tokens.ts`; Test `test/pi/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/tokens.test.ts
import { describe, it, expect } from "vitest";
import { newToken, hashToken, verifyTokenHash } from "../../src/pi/tokens.js";

describe("tokens", () => {
  it("generates a random token and verifies its hash", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(t); // stored hash != plaintext
    expect(verifyTokenHash(t, h)).toBe(true);
    expect(verifyTokenHash(newToken(), h)).toBe(false);
  });

  it("rejects a malformed stored hash without throwing", () => {
    expect(verifyTokenHash(newToken(), "nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/tokens.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/tokens.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/tokens.ts test/pi/tokens.test.ts
git commit -m "feat(sync): device token gen + hashing"
```

---

## Task 4: Store interface + in-memory implementation

**Files:** Create `src/pi/syncStore.ts`; Test `test/pi/syncStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/syncStore.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";

describe("InMemoryAccountStore", () => {
  it("creates an account, adds a device, and resolves it by token hash", async () => {
    const s = new InMemoryAccountStore();
    const acc = await s.createAccount("johnny", "pass-hash");
    expect(await s.findAccountByUsername("johnny")).toMatchObject({ id: acc.id, username: "johnny" });
    await s.addDevice(acc.id, { id: "dev-1", name: "iPad", tokenHash: "th-1", createdAt: "t", lastSeenAt: "t" });
    const found = await s.findByDeviceTokenHash("th-1");
    expect(found?.account.id).toBe(acc.id);
    expect(found?.device.id).toBe("dev-1");
    expect(await s.findByDeviceTokenHash("nope")).toBeNull();
  });

  it("merges a position via mergePosition and persists the winner", async () => {
    const s = new InMemoryAccountStore();
    const acc = await s.createAccount("u", "h");
    // device d2 sets p21
    let r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 21, manuallyMarked: false, device: "d2" });
    expect(r.value.pageIndex).toBe(21);
    // device d1 (behind, non-owner) -> ignored
    r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d1" });
    expect(r.changed).toBe(false);
    expect(r.value.pageIndex).toBe(21);
    // owner d2 regresses -> accepted
    r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d2" });
    expect(r.value.pageIndex).toBe(1);
  });

  it("returns positions changed since a timestamp", async () => {
    const s = new InMemoryAccountStore(() => "2026-06-17T00:00:00Z");
    const acc = await s.createAccount("u", "h");
    await s.upsertPositionMerged(acc.id, "https://x/a", { chapterOrder: 1, pageIndex: 0, manuallyMarked: false, device: "d1" });
    const all = await s.getPositionsSince(acc.id, null);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sourceUrl: "https://x/a", chapterOrder: 1, pageIndex: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/syncStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/syncStore.ts
import { mergePosition, type Position, type StoredPosition, type MergeResult } from "./positionMerge.js";

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface Account {
  id: string;
  username: string;
  passcodeHash: string;
  devices: Device[];
}

export interface PositionRow extends StoredPosition {
  sourceUrl: string;
  updatedAt: string;
}

export interface AccountStore {
  findAccountByUsername(username: string): Promise<Account | null>;
  createAccount(username: string, passcodeHash: string): Promise<Account>;
  addDevice(accountId: string, device: Device): Promise<void>;
  removeDevice(accountId: string, deviceId: string): Promise<void>;
  findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null>;
  touchDevice(accountId: string, deviceId: string): Promise<void>;
  upsertPositionMerged(
    accountId: string,
    sourceUrl: string,
    incoming: Position & { device: string },
  ): Promise<MergeResult>;
  getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]>;
}

/** Test/double implementation. The Pi uses PgAccountStore. */
export class InMemoryAccountStore implements AccountStore {
  private accounts = new Map<string, Account>();
  private positions = new Map<string, Map<string, PositionRow>>(); // accountId -> sourceUrl -> row
  private seq = 0;
  constructor(private now: () => string = () => new Date().toISOString()) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async findAccountByUsername(username: string): Promise<Account | null> {
    for (const a of this.accounts.values()) if (a.username === username) return a;
    return null;
  }
  async createAccount(username: string, passcodeHash: string): Promise<Account> {
    const acc: Account = { id: this.id("acc"), username, passcodeHash, devices: [] };
    this.accounts.set(acc.id, acc);
    return acc;
  }
  async addDevice(accountId: string, device: Device): Promise<void> {
    this.accounts.get(accountId)?.devices.push(device);
  }
  async removeDevice(accountId: string, deviceId: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) a.devices = a.devices.filter((d) => d.id !== deviceId);
  }
  async findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null> {
    for (const a of this.accounts.values()) {
      const d = a.devices.find((x) => x.tokenHash === tokenHash);
      if (d) return { account: a, device: d };
    }
    return null;
  }
  async touchDevice(accountId: string, deviceId: string): Promise<void> {
    const d = this.accounts.get(accountId)?.devices.find((x) => x.id === deviceId);
    if (d) d.lastSeenAt = this.now();
  }
  async upsertPositionMerged(
    accountId: string,
    sourceUrl: string,
    incoming: Position & { device: string },
  ): Promise<MergeResult> {
    let byUrl = this.positions.get(accountId);
    if (!byUrl) {
      byUrl = new Map();
      this.positions.set(accountId, byUrl);
    }
    const existing = byUrl.get(sourceUrl);
    const current: StoredPosition | null = existing
      ? { chapterOrder: existing.chapterOrder, pageIndex: existing.pageIndex, manuallyMarked: existing.manuallyMarked, ownerDevice: existing.ownerDevice }
      : null;
    const result = mergePosition(current, incoming);
    if (result.changed) {
      byUrl.set(sourceUrl, { ...result.value, sourceUrl, updatedAt: this.now() });
    }
    return result;
  }
  async getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]> {
    const rows = [...(this.positions.get(accountId)?.values() ?? [])];
    return since ? rows.filter((r) => r.updatedAt > since) : rows;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/syncStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/syncStore.ts test/pi/syncStore.test.ts
git commit -m "feat(sync): AccountStore interface + in-memory implementation"
```

---

## Task 5: Sync handlers (enroll, auth, position)

**Files:** Create `src/pi/syncHandlers.ts`; Test `test/pi/syncHandlers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/syncHandlers.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";
import { handleEnroll, resolveDevice, handlePutPosition, handleGetPositions, type SyncDeps } from "../../src/pi/syncHandlers.js";
import { hashToken } from "../../src/pi/tokens.js";

function deps(store: InMemoryAccountStore): SyncDeps {
  return {
    store,
    verifyOtp: (code) => code === "111111",
    now: () => "2026-06-17T00:00:00Z",
    newToken: () => "tok-plain",
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  };
}

describe("handleEnroll", () => {
  it("rejects a bad OTP with 401, creates no account", async () => {
    const store = new InMemoryAccountStore();
    const r = await handleEnroll({ username: "u", passcode: "p", otp: "000000", deviceName: "iPad" }, deps(store));
    expect(r.status).toBe(401);
    expect(await store.findAccountByUsername("u")).toBeNull();
  });

  it("creates a new account + device and returns a token on good OTP", async () => {
    const store = new InMemoryAccountStore();
    const r = await handleEnroll({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }, deps(store));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deviceToken: "tok-plain" });
    const found = await store.findByDeviceTokenHash(hashToken("tok-plain"));
    expect(found?.device.name).toBe("iPad");
  });

  it("rejects a wrong passcode for an existing username (401)", async () => {
    const store = new InMemoryAccountStore();
    await handleEnroll({ username: "u", passcode: "right", otp: "111111", deviceName: "A" }, deps(store));
    const r = await handleEnroll({ username: "u", passcode: "wrong", otp: "111111", deviceName: "B" }, deps(store));
    expect(r.status).toBe(401);
  });
});

describe("resolveDevice + position handlers", () => {
  async function enrolled() {
    const store = new InMemoryAccountStore();
    const d = deps(store);
    await handleEnroll({ username: "u", passcode: "p", otp: "111111", deviceName: "A" }, d);
    return { store, d };
  }

  it("resolves a device from a bearer token, rejects unknown", async () => {
    const { store, d } = await enrolled();
    expect(await resolveDevice("tok-plain", d)).not.toBeNull();
    expect(await resolveDevice("bogus", d)).toBeNull();
  });

  it("PUT position merges and GET returns it", async () => {
    const { store, d } = await enrolled();
    const ctx = (await resolveDevice("tok-plain", d))!;
    const put = await handlePutPosition(ctx, { sourceUrl: "https://x/s", chapterOrder: 12, pageIndex: 5, manuallyMarked: false }, d);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ chapterOrder: 12, pageIndex: 5 });
    const got = await handleGetPositions(ctx, null, d);
    expect(got.status).toBe(200);
    expect((got.body as { positions: unknown[] }).positions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/syncHandlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/syncHandlers.ts
import type { AccountStore, Account, Device } from "./syncStore.js";
import { hashPasscode, verifyPasscode } from "./passwords.js";
import { hashToken } from "./tokens.js";

export interface SyncDeps {
  store: AccountStore;
  /** Validate an OTP against the shared secret (wraps verifyTotp). */
  verifyOtp: (code: string) => boolean;
  now: () => string;
  newToken: () => string;
  newId: () => string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface DeviceContext {
  account: Account;
  device: Device;
}

export async function handleEnroll(
  input: { username: string; passcode: string; otp: string; deviceName: string },
  deps: SyncDeps,
): Promise<HandlerResult> {
  if (!deps.verifyOtp(input.otp)) return { status: 401, body: { error: "invalid authenticator code" } };
  if (!input.username || !input.passcode) return { status: 400, body: { error: "username and passcode required" } };

  let account = await deps.store.findAccountByUsername(input.username);
  if (account) {
    if (!verifyPasscode(input.passcode, account.passcodeHash)) {
      return { status: 401, body: { error: "invalid passcode" } };
    }
  } else {
    account = await deps.store.createAccount(input.username, hashPasscode(input.passcode));
  }

  const token = deps.newToken();
  const device: Device = {
    id: deps.newId(),
    name: input.deviceName || "device",
    tokenHash: hashToken(token),
    createdAt: deps.now(),
    lastSeenAt: deps.now(),
  };
  await deps.store.addDevice(account.id, device);
  return { status: 201, body: { accountId: account.id, deviceId: device.id, deviceToken: token } };
}

/** Resolve a bearer token to {account, device}, or null. Touches last-seen. */
export async function resolveDevice(token: string | null, deps: SyncDeps): Promise<DeviceContext | null> {
  if (!token) return null;
  const found = await deps.store.findByDeviceTokenHash(hashToken(token));
  if (!found) return null;
  await deps.store.touchDevice(found.account.id, found.device.id);
  return found;
}

export async function handlePutPosition(
  ctx: DeviceContext,
  input: { sourceUrl: string; chapterOrder: number; pageIndex: number; manuallyMarked: boolean },
  deps: SyncDeps,
): Promise<HandlerResult> {
  if (!input.sourceUrl || typeof input.chapterOrder !== "number" || typeof input.pageIndex !== "number") {
    return { status: 400, body: { error: "sourceUrl, chapterOrder, pageIndex required" } };
  }
  const result = await deps.store.upsertPositionMerged(ctx.account.id, input.sourceUrl, {
    chapterOrder: input.chapterOrder,
    pageIndex: input.pageIndex,
    manuallyMarked: !!input.manuallyMarked,
    device: ctx.device.id,
  });
  return { status: 200, body: { sourceUrl: input.sourceUrl, ...result.value } };
}

export async function handleGetPositions(
  ctx: DeviceContext,
  since: string | null,
  deps: SyncDeps,
): Promise<HandlerResult> {
  const positions = await deps.store.getPositionsSince(ctx.account.id, since);
  return { status: 200, body: { positions } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/syncHandlers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/syncHandlers.ts test/pi/syncHandlers.test.ts
git commit -m "feat(sync): enroll/auth/position handlers (store-agnostic)"
```

---

## Task 6: Wire sync routes into the HTTP API

**Files:** Modify `src/pi/api.ts`; Test `test/pi/api.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("api", …)` in `test/pi/api.test.ts`; the `startServer`/`deps` helpers already exist there — extend the deps object with the sync fields shown)

First, update the `startServer` deps in the existing `beforeEach` to include a store + sync deps. Add these imports at the top of the file:
```ts
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";
```
Add a module-level `let store: InMemoryAccountStore;`, set `store = new InMemoryAccountStore(() => "2026-06-17T00:00:00Z");` in `beforeEach`, and extend the `ctx = await startServer({ … })` deps with:
```ts
      store,
      verifyOtp: (code: string) => code === "111111",
      newToken: () => "tok-plain",
      newId: (() => { let n = 0; return () => `dev-${++n}`; })(),
```

Then append these tests:
```ts
  it("enrolls a device (bad OTP -> 401, good OTP -> 201 token)", async () => {
    const bad = await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "000000", deviceName: "iPad" }),
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).deviceToken).toBe("tok-plain");
  });

  it("rejects sync without a valid bearer token (401)", async () => {
    const res = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://x/s", chapterOrder: 1, pageIndex: 0, manuallyMarked: false }),
    });
    expect(res.status).toBe(401);
  });

  it("PUT then GET a position with a bearer token", async () => {
    await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
    });
    const auth = { "content-type": "application/json", authorization: "Bearer tok-plain" };
    const put = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ sourceUrl: "https://x/s", chapterOrder: 12, pageIndex: 5, manuallyMarked: false }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).pageIndex).toBe(5);
    const get = await fetch(`${ctx.base}/sync/positions`, { headers: { authorization: "Bearer tok-plain" } });
    expect(get.status).toBe(200);
    expect((await get.json()).positions).toHaveLength(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/api.test.ts`
Expected: FAIL — `store`/sync fields not on `ApiDeps`; sync routes 404.

- [ ] **Step 3: Implement — extend ApiDeps and add routes**

In `src/pi/api.ts`, add imports:
```ts
import type { AccountStore } from "./syncStore.js";
import { handleEnroll, resolveDevice, handlePutPosition, handleGetPositions, type SyncDeps } from "./syncHandlers.js";
```

Extend `ApiDeps` (add optional sync fields so non-sync deployments still typecheck):
```ts
  /** Sync backend (omit to disable the /enroll + /sync routes). */
  store?: AccountStore;
  verifyOtp?: (code: string) => boolean;
  newToken?: () => string;
  newId?: () => string;
```

Add a helper near the top (after `readBody`):
```ts
function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim() || null;
}

function syncDeps(deps: ApiDeps): SyncDeps | null {
  if (!deps.store || !deps.verifyOtp || !deps.newToken || !deps.newId) return null;
  return { store: deps.store, verifyOtp: deps.verifyOtp, now: () => new Date(deps.now()).toISOString(), newToken: deps.newToken, newId: deps.newId };
}
```

Add routes in `handleApiRequest` immediately BEFORE the final `json(res, 404, …)`:
```ts
  const sync = syncDeps(deps);
  if (sync && req.method === "POST" && path === "/enroll") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null) return json(res, 400, { error: "expected a JSON object body" });
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const r = await handleEnroll(
      {
        username: String(payload["username"] ?? ""),
        passcode: String(payload["passcode"] ?? ""),
        otp: String(payload["otp"] ?? ""),
        deviceName: String(payload["deviceName"] ?? "device"),
      },
      sync,
    );
    return json(res, r.status, r.body);
  }

  if (sync && (path === "/sync/position" || path === "/sync/positions")) {
    const ctx = await resolveDevice(bearer(req), sync);
    if (!ctx) return json(res, 401, { error: "invalid device token" });

    if (req.method === "PUT" && path === "/sync/position") {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const r = await handlePutPosition(
        ctx,
        {
          sourceUrl: String(payload["sourceUrl"] ?? ""),
          chapterOrder: Number(payload["chapterOrder"]),
          pageIndex: Number(payload["pageIndex"]),
          manuallyMarked: !!payload["manuallyMarked"],
        },
        sync,
      );
      return json(res, r.status, r.body);
    }
    if (req.method === "GET" && path === "/sync/positions") {
      const since = new URL(req.url ?? "/", "http://localhost").searchParams.get("since");
      const r = await handleGetPositions(ctx, since, sync);
      return json(res, r.status, r.body);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/api.test.ts && npx tsc --noEmit`
Expected: PASS (existing + 3 new); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/pi/api.ts test/pi/api.test.ts
git commit -m "feat(sync): /enroll + /sync/position + /sync/positions routes"
```

---

## Task 7: Postgres store + schema

**Files:** Create `src/pi/pgStore.ts`; Modify `package.json` (add `pg`, `@types/pg`)

- [ ] **Step 1: Add the dependency**

Run: `npm install pg && npm install -D @types/pg`
Expected: `pg` in dependencies, `@types/pg` in devDependencies.

- [ ] **Step 2: Write `src/pi/pgStore.ts`** (thin SQL implementing `AccountStore`; verified on the Pi — no sandbox Postgres)

```ts
// src/pi/pgStore.ts
import type { Pool } from "pg";
import { mergePosition, type Position, type StoredPosition, type MergeResult } from "./positionMerge.js";
import type { Account, AccountStore, Device, PositionRow } from "./syncStore.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  passcode_hash TEXT NOT NULL,
  devices       JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_positions (
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_url      TEXT NOT NULL,
  chapter_order   NUMERIC NOT NULL,
  page_index      INTEGER NOT NULL,
  owner_device    TEXT NOT NULL,
  manually_marked BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, source_url)
);
`;

interface AccountRow { id: string; username: string; passcode_hash: string; devices: Device[] }

function toAccount(r: AccountRow): Account {
  return { id: r.id, username: r.username, passcodeHash: r.passcode_hash, devices: r.devices ?? [] };
}

export class PgAccountStore implements AccountStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async findAccountByUsername(username: string): Promise<Account | null> {
    const r = await this.pool.query<AccountRow>("SELECT id, username, passcode_hash, devices FROM accounts WHERE username=$1", [username]);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }
  async createAccount(username: string, passcodeHash: string): Promise<Account> {
    const r = await this.pool.query<AccountRow>(
      "INSERT INTO accounts(username, passcode_hash) VALUES($1,$2) RETURNING id, username, passcode_hash, devices",
      [username, passcodeHash],
    );
    return toAccount(r.rows[0]!);
  }
  async addDevice(accountId: string, device: Device): Promise<void> {
    await this.pool.query(
      "UPDATE accounts SET devices = devices || $2::jsonb, updated_at=now() WHERE id=$1",
      [accountId, JSON.stringify([device])],
    );
  }
  async removeDevice(accountId: string, deviceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE accounts SET devices = (SELECT COALESCE(jsonb_agg(d),'[]'::jsonb) FROM jsonb_array_elements(devices) d WHERE d->>'id' <> $2), updated_at=now() WHERE id=$1`,
      [accountId, deviceId],
    );
  }
  async findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null> {
    const r = await this.pool.query<AccountRow>(
      `SELECT id, username, passcode_hash, devices FROM accounts WHERE devices @> $1::jsonb`,
      [JSON.stringify([{ tokenHash }])],
    );
    const row = r.rows[0];
    if (!row) return null;
    const account = toAccount(row);
    const device = account.devices.find((d) => d.tokenHash === tokenHash);
    return device ? { account, device } : null;
  }
  async touchDevice(accountId: string, deviceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE accounts SET devices = (SELECT jsonb_agg(CASE WHEN d->>'id'=$2 THEN jsonb_set(d,'{lastSeenAt}', to_jsonb(now()::text)) ELSE d END) FROM jsonb_array_elements(devices) d) WHERE id=$1`,
      [accountId, deviceId],
    );
  }
  async upsertPositionMerged(accountId: string, sourceUrl: string, incoming: Position & { device: string }): Promise<MergeResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        "SELECT chapter_order, page_index, owner_device, manually_marked FROM reading_positions WHERE account_id=$1 AND source_url=$2 FOR UPDATE",
        [accountId, sourceUrl],
      );
      const current: StoredPosition | null = cur.rows[0]
        ? { chapterOrder: Number(cur.rows[0].chapter_order), pageIndex: cur.rows[0].page_index, ownerDevice: cur.rows[0].owner_device, manuallyMarked: cur.rows[0].manually_marked }
        : null;
      const result = mergePosition(current, incoming);
      if (result.changed) {
        await client.query(
          `INSERT INTO reading_positions(account_id, source_url, chapter_order, page_index, owner_device, manually_marked, updated_at)
           VALUES($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (account_id, source_url) DO UPDATE SET
             chapter_order=EXCLUDED.chapter_order, page_index=EXCLUDED.page_index,
             owner_device=EXCLUDED.owner_device, manually_marked=EXCLUDED.manually_marked, updated_at=now()`,
          [accountId, sourceUrl, result.value.chapterOrder, result.value.pageIndex, result.value.ownerDevice, result.value.manuallyMarked],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]> {
    const sql = since
      ? "SELECT source_url, chapter_order, page_index, owner_device, manually_marked, updated_at FROM reading_positions WHERE account_id=$1 AND updated_at > $2"
      : "SELECT source_url, chapter_order, page_index, owner_device, manually_marked, updated_at FROM reading_positions WHERE account_id=$1";
    const params = since ? [accountId, since] : [accountId];
    const r = await this.pool.query(sql, params);
    return r.rows.map((row) => ({
      sourceUrl: row.source_url,
      chapterOrder: Number(row.chapter_order),
      pageIndex: row.page_index,
      ownerDevice: row.owner_device,
      manuallyMarked: row.manually_marked,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString(),
    }));
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (the `pg` types resolve `Pool`).

- [ ] **Step 4: Commit**

```bash
git add src/pi/pgStore.ts package.json package-lock.json
git commit -m "feat(sync): Postgres AccountStore + schema"
```

---

## Task 8: API entrypoint + Postgres compose service

**Files:** Modify `scripts/pi-api.mjs`, `docker-compose.yml`

- [ ] **Step 1: Wire the store into `scripts/pi-api.mjs`**

Add near the top:
```js
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PgAccountStore } from "../dist/pi/pgStore.js";
import { verifyTotp } from "../dist/pi/totp.js";
```
After the existing `deps` object is built, set up the store when `DATABASE_URL` is present:
```js
let store;
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  store = new PgAccountStore(pool);
  await store.init();
  deps.store = store;
  deps.verifyOtp = (code) => verifyTotp(SECRET, code, Date.now());
  deps.newToken = () => randomBytes(32).toString("hex");
  deps.newId = () => randomUUID();
  console.log("[pi-api] sync backend enabled (postgres)");
} else {
  console.log("[pi-api] sync backend disabled (no DATABASE_URL)");
}
```
(`randomBytes` is already imported in this file; if not, add it to the `node:crypto` import. `SECRET` is the existing `SCRAPE_TOTP_SECRET` const.)

- [ ] **Step 2: Add Postgres to `docker-compose.yml`**

```yaml
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: verreaux
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: verreaux
    volumes:
      - ./data/pg:/var/lib/postgresql/data
```
And add to the `api` service: `depends_on: [flaresolverr, postgres]` and under its `environment:` add
`DATABASE_URL: postgres://verreaux:${POSTGRES_PASSWORD}@postgres:5432/verreaux`.

- [ ] **Step 3: Validate compose config**

Run: `SCRAPE_TOTP_SECRET=dummy POSTGRES_PASSWORD=dummy docker compose config >/dev/null && echo "compose VALID"`
Expected: `compose VALID` (4 services: worker, api, flaresolverr, postgres).

- [ ] **Step 4: Build + full test suite (no Postgres needed — sandbox)**

Run: `npm run build && npx vitest run`
Expected: build clean; all tests pass (pure + InMemory cover the logic).

- [ ] **Step 5: Commit**

```bash
git add scripts/pi-api.mjs docker-compose.yml
git commit -m "feat(sync): wire PgAccountStore into api entrypoint + postgres compose service"
```

- [ ] **Step 6: Deploy + verify on the Pi (operational — needs the Pi)**

On the Pi:
```bash
cd ~/verreaux && git pull
printf "POSTGRES_PASSWORD=%s\n" "$(openssl rand -hex 16)" >> .env
sudo docker compose build && sudo docker compose up -d
sudo docker compose ps   # worker, api, flaresolverr, postgres running
```
Then from any device (live OTP minted via `node scripts/totp.mjs now`):
```bash
BASE=https://pajohn.tail8f51b4.ts.net
curl -s -X POST $BASE/enroll -H 'content-type: application/json' \
  -d "{\"username\":\"johnny\",\"passcode\":\"p\",\"otp\":\"<OTP>\",\"deviceName\":\"laptop\"}"   # -> {deviceToken}
TOK=<deviceToken>
curl -s -X PUT $BASE/sync/position -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"sourceUrl":"https://qimanhwa.com/series/x","chapterOrder":12,"pageIndex":5,"manuallyMarked":false}'
curl -s $BASE/sync/positions -H "authorization: Bearer $TOK"   # -> {positions:[...]}
```
Expected: enroll returns a token; PUT returns the merged position; GET lists it.

---

## Self-Review

**Spec coverage:**
- Postgres sidecar + schema → Tasks 7, 8. ✓
- `accounts(username, passcode_hash, devices JSONB)` + `reading_positions(...)` → Task 7 `SCHEMA_SQL`. ✓
- Enroll gated by shared TOTP; passcode verify; device token issue → Tasks 2, 3, 5, 6, 8. ✓
- Bearer-token auth on routine syncs → Tasks 5 (`resolveDevice`), 6. ✓
- Merge rule (furthest-wins + owner regression, order-then-page, fractional, tie, manual) → Task 1. ✓
- `PUT /sync/position` + `GET /sync/positions?since=` → Tasks 5, 6. ✓
- Server-assigned timestamps + `owner_device` → Tasks 4 (`now()` in store), 7 (`now()` SQL), 1 (ownerDevice). ✓
- Atomic merge under row lock → Task 7 (`FOR UPDATE` + tx). ✓
- Device revoke → Task 4/7 (`removeDevice`); the revoke *endpoint* (OTP-gated) is deferred to a follow-up note below.
- PWA client (accountClient, positionSync, Settings, push/pull) → **Part 2** (separate plan, app repo).

**Placeholder scan:** No TBD/TODO; pure modules have full code + tests; pg/compose tasks have complete code and on-Pi verification (sandbox can't run Postgres). ✓

**Type consistency:** `Position`/`StoredPosition`/`MergeResult` from `positionMerge.ts` are reused by `syncStore.ts`, `pgStore.ts`, `syncHandlers.ts`. `Account`/`Device`/`PositionRow`/`AccountStore` from `syncStore.ts` are implemented by both `InMemoryAccountStore` and `PgAccountStore` and consumed by `syncHandlers.ts`. `SyncDeps`/`DeviceContext`/`HandlerResult` consistent across handlers + api wiring. `ApiDeps` gains optional `store/verifyOtp/newToken/newId`. ✓

**Deferred (note, not gap):** an OTP-gated **revoke-device** endpoint and **change-passcode** endpoint — the store methods exist (`removeDevice`); wiring their routes is a small follow-up once the enroll/sync core is proven. Captured here so it isn't lost.
