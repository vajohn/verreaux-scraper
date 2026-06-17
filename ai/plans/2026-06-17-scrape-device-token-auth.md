# Scrape Device-Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Pi's `POST /scrape` authorize a request that carries a valid device bearer token, in addition to the existing OTP path, so sync-driven (catch-up) downloads need no OTP prompt.

**Architecture:** `/scrape` currently gates solely on `verifyTotp`. Add a fallback: if the OTP is absent/invalid, try resolving an `Authorization: Bearer <token>` header through the same `resolveDevice` used by `/sync/*`. Authorize when *either* succeeds. No change to the job-queue drop-folder mechanics. When the sync backend is disabled (`syncDeps` returns null), only the OTP path exists — unchanged from today.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import extensions), Node `http`, vitest (node).

**This is Plan A. It must land before the PWA plan (`app/ai/plans/2026-06-17-sync-content-download.md`), whose catch-up downloads depend on this token auth.**

---

### Task 1: `/scrape` accepts a device bearer token OR an OTP

**Files:**
- Modify: `src/pi/api.ts` (the `POST /scrape` block, ~lines 76-108; move `syncDeps` resolution earlier)
- Test: `test/pi/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these inside the existing `describe("api", ...)` block in `test/pi/api.test.ts` (the harness already enrolls with `otp: "111111"` → `deviceToken: "tok-plain"`):

```ts
it("accepts POST /scrape with a valid device bearer token and no OTP (201)", async () => {
  await fetch(`${ctx.base}/enroll`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
  });
  const res = await fetch(`${ctx.base}/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok-plain" },
    body: JSON.stringify({ url: "https://x.test/s", args: "--from 49 --to latest" }),
  });
  expect(res.status).toBe(201);
  expect(readdirSync(dirs.jobs)).toHaveLength(1);
});

it("rejects POST /scrape with an invalid bearer token and no OTP (401)", async () => {
  const res = await fetch(`${ctx.base}/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
    body: JSON.stringify({ url: "https://x.test/s" }),
  });
  expect(res.status).toBe(401);
  expect(readdirSync(dirs.jobs)).toEqual([]);
});

it("still accepts POST /scrape with a valid OTP and no token (201)", async () => {
  const res = await fetch(`${ctx.base}/scrape`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://x.test/s", otp: totp(SECRET, 1_700_000_000_000) }),
  });
  expect(res.status).toBe(201);
});
```

- [ ] **Step 2: Run the tests to verify the first two fail**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/api.test.ts`
Expected: the "valid device bearer token" test FAILS with 401 (token path not implemented yet); the OTP tests PASS.

- [ ] **Step 3: Implement the dual auth in `src/pi/api.ts`**

Move the `sync` resolution above the `/scrape` block, then add the token fallback. Replace this current region:

```ts
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "POST" && path === "/scrape") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(res, 400, { error: "expected a JSON object body" });
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    if (!verifyTotp(deps.secret, String(payload["otp"] ?? ""), deps.now())) {
      return json(res, 401, { error: "invalid authenticator code" });
    }
    const id = generateJobId(new Date(deps.now()), deps.newSuffix());
```

with:

```ts
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Resolved once up-front: /scrape may authorize via a device token, and the
  // /enroll + /sync routes need it too. Null when the sync backend is disabled.
  const sync = syncDeps(deps);

  if (req.method === "POST" && path === "/scrape") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(res, 400, { error: "expected a JSON object body" });
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    // Authorize on EITHER a valid OTP or a valid device bearer token. The token
    // path lets sync-driven (catch-up) downloads run without an OTP prompt; it
    // is only available when the sync backend is configured.
    let authed = verifyTotp(deps.secret, String(payload["otp"] ?? ""), deps.now());
    if (!authed && sync) {
      authed = (await resolveDevice(bearer(req), sync)) !== null;
    }
    if (!authed) {
      return json(res, 401, { error: "invalid authenticator code or device token" });
    }
    const id = generateJobId(new Date(deps.now()), deps.newSuffix());
```

Then delete the now-duplicate later declaration. Find this line further down (just above the `/enroll` block):

```ts
  const sync = syncDeps(deps);
  if (sync && req.method === "POST" && path === "/enroll") {
```

and remove the `const sync = syncDeps(deps);` line there (keep the `if`):

```ts
  if (sync && req.method === "POST" && path === "/enroll") {
```

(`resolveDevice` and `bearer` are already imported / defined in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/api.test.ts`
Expected: PASS (all api tests, including the three new ones).

- [ ] **Step 5: Typecheck the build**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors (in particular, no "used before declaration" for `sync`).

- [ ] **Step 6: Commit**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git add src/pi/api.ts test/pi/api.test.ts
git commit -m "feat(pi): /scrape accepts a device bearer token in addition to OTP

Sync-driven catch-up downloads carry the device's existing sync token, so
they no longer need an OTP prompt. Manual scrapes (OTP) are unchanged; when
the sync backend is disabled only the OTP path exists.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** Covers the spec's sole backend item ("extend `POST /scrape` to also accept `Authorization: Bearer <deviceToken>`, reusing `resolveDevice`; OTP path stays"). ✓
- **Placeholder scan:** None.
- **Type consistency:** `resolveDevice(token: string | null, deps: SyncDeps)` and `bearer(req): string | null` match the call `resolveDevice(bearer(req), sync)`; `sync` is `SyncDeps | null`, guarded by `if (!authed && sync)`. ✓
- **Edge — sync disabled:** `sync` is null → token path skipped → behaves exactly as today (OTP-only). ✓
