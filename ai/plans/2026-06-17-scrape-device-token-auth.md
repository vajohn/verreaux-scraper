# Pi Backend for Sync Content Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Pi-side capabilities behind sync-driven content download: (1) `POST /scrape` authorizes a valid device bearer token in addition to OTP, so catch-up downloads need no OTP prompt; (2) a catch-up scrape reuses chapters from a recent run ZIP already on the Pi, re-scraping only the genuinely-new tail from the source site.

**Architecture:**
- **Auth (Task 1):** `/scrape` currently gates solely on `verifyTotp`. Add a fallback — if the OTP is absent/invalid, resolve an `Authorization: Bearer <token>` header through the same `resolveDevice` used by `/sync/*`. Authorize when *either* succeeds. When the sync backend is disabled (`syncDeps` null), only the OTP path exists, unchanged.
- **ZIP reuse (Tasks 2-5):** wraps *around* the scrape — the scraper pipeline is untouched. For a `--from F --to latest` job the worker indexes completed run ZIPs in `done/`, finds the contiguous cached chapter run starting at `F` (`F..K`) for this `sourceUrl`, narrows the scrape to `--from K+1 --to latest`, then assembles `output.zip` from the cached `F..K` chapters + the freshly-scraped delta + a recomputed `verreaux.json`. Nothing cached → behaves exactly as today. Cache lives in the existing TTL-bounded `done/` dir; reuse is keyed on `(sourceUrl, chapterOrder)` and is safe because a published chapter's images do not change.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import extensions), Node `http`, `adm-zip` (already a dependency, used for reading) + `archiver` (already used for writing), vitest (node).

**This is Plan A. Task 1 (token auth) must land before the PWA plan (`app/ai/plans/2026-06-17-sync-content-download.md`), whose catch-up downloads depend on it. Tasks 2-5 (ZIP reuse) are a speed optimization — independent of the PWA work and safely deferrable, but planned here per the design.**

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

### Task 2: Index completed run ZIPs by source URL

**Files:**
- Create: `src/pi/zipIndex.ts`
- Test: `test/pi/zipIndex.test.ts`

Reads each `done/<run>/output.zip`, parses its root `verreaux.json` for the `sourceUrl`, and enumerates the chapter orders present (from entry paths `<seriesFolder>/<chapterName>/<page>`). Produces, per `sourceUrl`, the candidate cached ZIPs newest-first.

- [ ] **Step 1: Write the failing test**

Create `test/pi/zipIndex.test.ts`. It builds real fixture ZIPs with `adm-zip`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { indexDoneZips } from "../../src/pi/zipIndex.js";

function writeZip(doneDir: string, runId: string, sourceUrl: string, orders: number[]): void {
  mkdirSync(join(doneDir, runId), { recursive: true });
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl, seriesTitle: "S", adapter: "a",
    chapterRange: { from: orders[0] ?? 0, to: "latest" }, generatedAt: "t",
  })));
  for (const o of orders) zip.addFile(`S/chapter-${o}/001.webp`, Buffer.from("img"));
  zip.writeZip(join(doneDir, runId, "output.zip"));
}

describe("indexDoneZips", () => {
  let doneDir: string;
  beforeEach(() => { doneDir = mkdtempSync(join(tmpdir(), "done-")); });

  it("indexes orders per sourceUrl, newest run first", async () => {
    writeZip(doneDir, "20260101-000000-aaaa", "https://x/s", [49, 50, 51]);
    writeZip(doneDir, "20260102-000000-bbbb", "https://x/s", [49, 50, 51, 52]);
    const index = await indexDoneZips(doneDir);
    const entries = index.get("https://x/s")!;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.runId).toBe("20260102-000000-bbbb"); // newest first
    expect([...entries[0]!.orders].sort((a, b) => a - b)).toEqual([49, 50, 51, 52]);
  });

  it("ignores run dirs without an output.zip and returns an empty map for none", async () => {
    mkdirSync(join(doneDir, "20260101-000000-cccc"), { recursive: true }); // no zip
    const index = await indexDoneZips(doneDir);
    expect(index.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/zipIndex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/pi/zipIndex.ts`**

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { VerreauxManifest } from "./manifest.js";

// adm-zip is CommonJS; load via createRequire under NodeNext ESM.
const _require = createRequire(import.meta.url);
const AdmZip = _require("adm-zip") as typeof import("adm-zip");

export interface CachedZip {
  runId: string;
  zipPath: string;
  seriesFolder: string;
  orders: Set<number>;
  mtimeMs: number;
}

/** Chapter order from a chapter-folder name (mirrors packager's extractSortKey). */
function orderFromChapterName(name: string): number | null {
  const m = name.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10);
}

/** Index every `done/<run>/output.zip` by its manifest sourceUrl. Each source's
 *  candidate ZIPs are returned newest-first (by run dir mtime). Best-effort:
 *  unreadable or manifest-less ZIPs are skipped. */
export async function indexDoneZips(doneDir: string): Promise<Map<string, CachedZip[]>> {
  const out = new Map<string, CachedZip[]>();
  let runIds: string[];
  try {
    runIds = (await readdir(doneDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const runId of runIds) {
    const zipPath = join(doneDir, runId, "output.zip");
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(zipPath)).mtimeMs;
    } catch {
      continue; // no output.zip yet (running/failed run)
    }
    try {
      const zip = new AdmZip(zipPath);
      const manifestEntry = zip.getEntry("verreaux.json");
      if (!manifestEntry) continue;
      const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as VerreauxManifest;
      if (!manifest.sourceUrl) continue;
      const orders = new Set<number>();
      let seriesFolder = "";
      for (const e of zip.getEntries()) {
        const parts = e.entryName.split("/");
        if (parts.length < 2 || parts[0] === "verreaux.json") continue;
        seriesFolder = parts[0]!;
        const ord = orderFromChapterName(parts[1]!);
        if (ord !== null) orders.add(ord);
      }
      if (orders.size === 0) continue;
      const list = out.get(manifest.sourceUrl) ?? [];
      list.push({ runId, zipPath, seriesFolder, orders, mtimeMs });
      out.set(manifest.sourceUrl, list);
    } catch {
      continue;
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/zipIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git add src/pi/zipIndex.ts test/pi/zipIndex.test.ts
git commit -m "feat(pi): index completed run ZIPs by source URL

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Plan cache reuse (pure)

**Files:**
- Create: `src/pi/cachePlan.ts`
- Test: `test/pi/cachePlan.test.ts`

Given a requested `from` and the candidate cached ZIPs (newest-first) for a source URL, pick the freshest ZIP that has **any** order ≥ `from`, reuse all its in-range orders, and compute the disjoint ranges still to scrape: the integer **gaps** within the cached span (including the lower gap `from..firstCached-1`) plus the **tail** above the cached block (`to: "latest"`, always scraped to pick up newer chapters). Returns null when no candidate has anything reusable for the range (caller then scrapes the original range whole).

- [ ] **Step 1: Write the failing test**

Create `test/pi/cachePlan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planCacheReuse } from "../../src/pi/cachePlan.js";
import type { CachedZip } from "../../src/pi/zipIndex.js";

function zip(orders: number[], mtimeMs = 1): CachedZip {
  return { runId: "r", zipPath: "/p.zip", seriesFolder: "S", orders: new Set(orders), mtimeMs };
}

describe("planCacheReuse", () => {
  it("contiguous-from-`from`: reuse the block, scrape only the tail", () => {
    const plan = planCacheReuse(49, [zip([49, 50, 51, 52])])!;
    expect(plan.reuseOrders).toEqual([49, 50, 51, 52]);
    expect(plan.scrapeSegments).toEqual([{ from: 53, to: "latest" }]);
  });

  it("floating chunk above `from`: scrape the lower gap, reuse the chunk, scrape the tail", () => {
    const plan = planCacheReuse(49, [zip([55, 56, 57, 58])])!; // case 2
    expect(plan.reuseOrders).toEqual([55, 56, 57, 58]);
    expect(plan.scrapeSegments).toEqual([
      { from: 49, to: 54 },     // lower gap
      { from: 59, to: "latest" }, // tail
    ]);
  });

  it("internal hole: scrape just the missing integers plus the tail", () => {
    const plan = planCacheReuse(49, [zip([49, 50, 52])])!; // 51 missing
    expect(plan.reuseOrders).toEqual([49, 50, 52]);
    expect(plan.scrapeSegments).toEqual([
      { from: 51, to: 51 },
      { from: 53, to: "latest" },
    ]);
  });

  it("cache wholly below `from` (or empty): no reuse", () => {
    expect(planCacheReuse(49, [zip([20, 30])])).toBeNull();
    expect(planCacheReuse(49, [])).toBeNull();
  });

  it("skips a candidate with nothing in range and uses the next that has some", () => {
    const plan = planCacheReuse(49, [zip([20, 30]), zip([55, 56])])!;
    expect(plan.reuseOrders).toEqual([55, 56]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/cachePlan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/pi/cachePlan.ts`**

```ts
import type { CachedZip } from "./zipIndex.js";

export interface ScrapeSegment {
  from: number;
  to: number | "latest";
}

export interface CacheReusePlan {
  cachedZip: CachedZip;
  /** Cached orders (>= from) to copy into the assembled output. */
  reuseOrders: number[];
  /** Disjoint ranges to scrape fresh: integer gaps within the cached span,
   *  then the tail above it (`to: "latest"`). */
  scrapeSegments: ScrapeSegment[];
}

/**
 * From the candidate cached ZIPs (newest-first), pick the first that has any
 * order >= `from`. Reuse all its in-range orders; scrape the integer gaps
 * between `from` and the highest cached order, plus the tail above it. Returns
 * null when no candidate has anything reusable (caller scrapes the original
 * range). `from` is always an integer here (parseFromArg only matches `\d+`).
 */
export function planCacheReuse(from: number, candidates: CachedZip[]): CacheReusePlan | null {
  for (const cachedZip of candidates) {
    const inRange = [...cachedZip.orders].filter((o) => o >= from).sort((a, b) => a - b);
    if (inRange.length === 0) continue;
    const floorE = Math.floor(inRange[inRange.length - 1]!);
    const present = new Set(inRange);
    const segments: ScrapeSegment[] = [];

    // Integer gaps within [from .. floorE] — includes the lower gap
    // [from .. firstCached-1] when the cached block floats above `from`.
    let gapStart: number | null = null;
    for (let k = from; k <= floorE; k++) {
      const missing = !present.has(k);
      if (missing && gapStart === null) gapStart = k;
      if (!missing && gapStart !== null) {
        segments.push({ from: gapStart, to: k - 1 });
        gapStart = null;
      }
    }
    if (gapStart !== null) segments.push({ from: gapStart, to: floorE });

    // Tail above the cached block — always scraped to catch newer chapters.
    segments.push({ from: floorE + 1, to: "latest" });

    return { cachedZip, reuseOrders: inRange, scrapeSegments: segments };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/cachePlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git add src/pi/cachePlan.ts test/pi/cachePlan.test.ts
git commit -m "feat(pi): gap-filling cache-reuse range planner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Assemble output ZIP from cached chapters + delta(s)

**Files:**
- Create: `src/pi/zipAssemble.ts`
- Test: `test/pi/zipAssemble.test.ts`

Writes a combined `output.zip`: the reused chapters copied from the cached ZIP + every chapter from each delta scrape ZIP + a recomputed root `verreaux.json`. Delta chapters win on any overlapping folder. The cover is taken from a delta if present, else the cached ZIP.

- [ ] **Step 1: Write the failing test**

Create `test/pi/zipAssemble.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { assembleOutputZip } from "../../src/pi/zipAssemble.js";

function makeZip(path: string, folder: string, orders: number[], withCover = false): void {
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl: "https://x/s", seriesTitle: folder, adapter: "a",
    chapterRange: { from: orders[0] ?? 0, to: "latest" }, generatedAt: "t",
  })));
  if (withCover) zip.addFile(`${folder}/cover.webp`, Buffer.from("cov"));
  for (const o of orders) zip.addFile(`${folder}/chapter-${o}/001.webp`, Buffer.from(`p${o}`));
  zip.writeZip(path);
}

function chaptersOf(zipPath: string): string[] {
  return [...new Set(new AdmZip(zipPath).getEntries()
    .map((e) => e.entryName.split("/")[1])
    .filter((n): n is string => !!n && n.startsWith("chapter-")))].sort();
}

describe("assembleOutputZip", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "asm-")); });

  it("merges reused cached chapters + multiple delta ZIPs with a recomputed manifest", async () => {
    const cached = join(dir, "cached.zip");
    const d1 = join(dir, "d1.zip");
    const d2 = join(dir, "d2.zip");
    makeZip(cached, "S", [55, 56, 57, 58], true); // floating cached chunk
    makeZip(d1, "S", [49, 50, 51, 52, 53, 54]);    // lower-gap delta
    makeZip(d2, "S", [59, 60]);                     // tail delta
    const outPath = join(dir, "output");

    await assembleOutputZip({
      cachedZipPath: cached, seriesFolder: "S", reuseOrders: [55, 56, 57, 58],
      deltaZipPaths: [d1, d2], outPath, from: 49,
    });

    expect(chaptersOf(`${outPath}.zip`)).toEqual(
      ["chapter-49","chapter-50","chapter-51","chapter-52","chapter-53","chapter-54","chapter-55","chapter-56","chapter-57","chapter-58","chapter-59","chapter-60"],
    );
    const manifest = JSON.parse(new AdmZip(`${outPath}.zip`).getEntry("verreaux.json")!.getData().toString("utf8"));
    expect(manifest.chapterRange).toEqual({ from: 49, to: 60 });
    expect(new AdmZip(`${outPath}.zip`).getEntry("S/cover.webp")).toBeTruthy(); // carried from cached
  });

  it("works with no deltas (cached window alone)", async () => {
    const cached = join(dir, "cached.zip");
    makeZip(cached, "S", [49, 50], true);
    const outPath = join(dir, "output");
    await assembleOutputZip({
      cachedZipPath: cached, seriesFolder: "S", reuseOrders: [49, 50],
      deltaZipPaths: [], outPath, from: 49,
    });
    const manifest = JSON.parse(new AdmZip(`${outPath}.zip`).getEntry("verreaux.json")!.getData().toString("utf8"));
    expect(manifest.chapterRange).toEqual({ from: 49, to: 50 });
    expect(chaptersOf(`${outPath}.zip`)).toEqual(["chapter-49", "chapter-50"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/zipAssemble.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/pi/zipAssemble.ts`**

```ts
import { rename } from "node:fs/promises";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const AdmZip = _require("adm-zip") as typeof import("adm-zip");

export interface AssembleOpts {
  cachedZipPath: string;
  seriesFolder: string;
  /** Whole orders to copy from the cached ZIP. */
  reuseOrders: number[];
  /** Zero or more delta scrape outputs (disjoint ranges). Delta wins on overlap. */
  deltaZipPaths: string[];
  /** Output path WITHOUT the `.zip` extension. */
  outPath: string;
  /** Original requested `from`, recorded in the recomputed manifest. */
  from: number;
}

const CHAPTER_RE = /^(.+?)\/(chapter[^/]*)\//i;

function orderOf(chapterFolder: string): number {
  const m = chapterFolder.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10);
}

/**
 * Build `<outPath>.zip` from the reused cached chapters + every delta chapter,
 * with a recomputed root verreaux.json (`from` original, `to` = highest order
 * present). Delta entries win on overlap. Atomic via .tmp + rename.
 */
export async function assembleOutputZip(opts: AssembleOpts): Promise<void> {
  const out = new AdmZip();
  const seenChapters = new Set<string>();
  let maxOrder = opts.from;
  let manifestTemplate: Record<string, unknown> | null = null;

  // Deltas first so their chapters take precedence on any overlap. The deltas
  // are disjoint ranges, so order among them does not matter.
  for (const deltaPath of opts.deltaZipPaths) {
    const delta = new AdmZip(deltaPath);
    for (const e of delta.getEntries()) {
      if (e.entryName === "verreaux.json") {
        if (!manifestTemplate) manifestTemplate = JSON.parse(e.getData().toString("utf8")) as Record<string, unknown>;
        continue;
      }
      const m = e.entryName.match(CHAPTER_RE);
      if (m) {
        seenChapters.add(m[2]!);
        maxOrder = Math.max(maxOrder, orderOf(m[2]!));
      }
      if (!out.getEntry(e.entryName)) out.addFile(e.entryName, e.getData());
    }
  }

  // Reused cached chapters: only the planned orders, only folders no delta gave.
  const reuse = new Set(opts.reuseOrders);
  const cached = new AdmZip(opts.cachedZipPath);
  for (const e of cached.getEntries()) {
    if (e.entryName === "verreaux.json") {
      if (!manifestTemplate) manifestTemplate = JSON.parse(e.getData().toString("utf8")) as Record<string, unknown>;
      continue;
    }
    const m = e.entryName.match(CHAPTER_RE);
    if (m) {
      const folder = m[2]!;
      if (seenChapters.has(folder)) continue;     // a delta already provided it
      if (!reuse.has(orderOf(folder))) continue;   // not in the reuse plan
      maxOrder = Math.max(maxOrder, orderOf(folder));
      out.addFile(e.entryName, e.getData());
      continue;
    }
    // Non-chapter entry (e.g. cover) — carry only if no delta already added one.
    if (!out.getEntry(e.entryName)) out.addFile(e.entryName, e.getData());
  }

  const manifest = {
    schema: 1,
    sourceUrl: (manifestTemplate?.["sourceUrl"] as string) ?? "",
    seriesTitle: (manifestTemplate?.["seriesTitle"] as string) ?? opts.seriesFolder,
    adapter: (manifestTemplate?.["adapter"] as string) ?? "",
    chapterRange: { from: opts.from, to: maxOrder },
    generatedAt: (manifestTemplate?.["generatedAt"] as string) ?? "",
  };
  if (out.getEntry("verreaux.json")) out.deleteFile("verreaux.json");
  out.addFile("verreaux.json", Buffer.from(JSON.stringify(manifest, null, 2)));

  const tmp = `${opts.outPath}.zip.tmp`;
  out.writeZip(tmp);
  await rename(tmp, `${opts.outPath}.zip`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/zipAssemble.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git add src/pi/zipAssemble.ts test/pi/zipAssemble.test.ts
git commit -m "feat(pi): assemble output ZIP from cached chapters + delta scrapes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire cache-assisted scraping into the worker

**Files:**
- Create: `src/pi/cacheAssist.ts` (the orchestrator the worker calls)
- Modify: `scripts/pi-watcher.mjs` (use it in the `runScrape` dep)
- Test: `test/pi/cacheAssist.test.ts`

`cacheAssist` plans reuse, runs **one scrape per gap/tail segment** into its own temp dir, then assembles the cached reuse + every delta into `outDir/output.zip`. It is injected with a `scrape(extraArgs, outDir)` callback (the worker passes the real CLI spawn) so it is testable without spawning.

- [ ] **Step 1: Write the failing test**

Create `test/pi/cacheAssist.test.ts`. The fake `scrape` reads `--from/--to` from the argv and emits a delta ZIP for that range, so we exercise the full multi-segment plan + assembly:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { runScrapeWithCache, parseFromArg } from "../../src/pi/cacheAssist.js";

function writeRunZip(doneDir: string, runId: string, orders: number[]): void {
  mkdirSync(join(doneDir, runId), { recursive: true });
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a",
    chapterRange: { from: orders[0]!, to: "latest" }, generatedAt: "t",
  })));
  for (const o of orders) zip.addFile(`S/chapter-${o}/001.webp`, Buffer.from(`p${o}`));
  zip.writeZip(join(doneDir, runId, "output.zip"));
}

function chaptersOf(zipPath: string): string[] {
  return [...new Set(new AdmZip(zipPath).getEntries()
    .map((e) => e.entryName.split("/")[1])
    .filter((n): n is string => !!n && n.startsWith("chapter-")))].sort();
}

/** Fake scrape: emit chapters for the requested [--from .. --to] range. `latest`
 *  is treated as `LATEST`. Empty range -> no zip, non-zero exit (like ERR_EMPTY_RANGE). */
function fakeScrape(LATEST: number, calls: string[][]) {
  return async (extraArgs: string[], dir: string): Promise<number> => {
    calls.push(extraArgs);
    const fi = extraArgs.indexOf("--from");
    const ti = extraArgs.indexOf("--to");
    const from = parseInt(extraArgs[fi + 1]!, 10);
    const toRaw = extraArgs[ti + 1]!;
    const to = toRaw === "latest" ? LATEST : parseInt(toRaw, 10);
    if (from > to) return 1; // empty range
    const zip = new AdmZip();
    zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
      schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a",
      chapterRange: { from, to: toRaw === "latest" ? "latest" : to }, generatedAt: "t",
    })));
    for (let o = from; o <= to; o++) zip.addFile(`S/chapter-${o}/001.webp`, Buffer.from(`p${o}`));
    zip.writeZip(join(dir, "output.zip"));
    return 0;
  };
}

describe("runScrapeWithCache", () => {
  let doneDir: string;
  beforeEach(() => { doneDir = mkdtempSync(join(tmpdir(), "ca-")); });

  it("parseFromArg reads the integer --from", () => {
    expect(parseFromArg("--from 49 --to latest")).toBe(49);
    expect(parseFromArg("--to latest")).toBeNull();
  });

  it("floating cached chunk: scrapes lower gap + tail, reuses the chunk (case 2)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [55, 56, 57, 58]); // cached
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(60, calls),
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([
      ["--from", "49", "--to", "54"],     // lower gap
      ["--from", "59", "--to", "latest"], // tail
    ]);
    expect(chaptersOf(join(outDir, "output.zip"))).toEqual(
      ["chapter-49","chapter-50","chapter-51","chapter-52","chapter-53","chapter-54","chapter-55","chapter-56","chapter-57","chapter-58","chapter-59","chapter-60"],
    );
  });

  it("contiguous cache with no newer chapters: empty tail -> serve cached window alone (case 3)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [49, 50, 51]); // cached up to latest
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(51, calls), // LATEST = 51, so tail 52..51 is empty
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([["--from", "52", "--to", "latest"]]); // tail only, returns empty
    expect(chaptersOf(join(outDir, "output.zip"))).toEqual(["chapter-49", "chapter-50", "chapter-51"]);
  });

  it("cache wholly below `from`: plain scrape of the original range, no assembly (case 1)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [20, 30]); // ignored
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(52, calls),
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([["--from", "49", "--to", "latest"]]); // original args, into outDir
    expect(chaptersOf(join(outDir, "output.zip"))).toEqual(["chapter-49","chapter-50","chapter-51","chapter-52"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/cacheAssist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/pi/cacheAssist.ts`**

```ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScrapeJob } from "./job.js";
import { indexDoneZips } from "./zipIndex.js";
import { planCacheReuse, type ScrapeSegment } from "./cachePlan.js";
import { assembleOutputZip } from "./zipAssemble.js";

/** Parse `--from N` out of a job's arg string. Null if absent/non-integer. */
export function parseFromArg(args: string): number | null {
  const m = args.match(/--from\s+(\d+)\b/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Rebuild the job's argv for one scrape segment (override --from / --to). */
function segmentArgs(jobArgs: string, seg: ScrapeSegment): string[] {
  let s = jobArgs;
  s = /--from\s+\S+/.test(s) ? s.replace(/--from\s+\S+/, `--from ${seg.from}`) : `${s} --from ${seg.from}`;
  s = /--to\s+\S+/.test(s) ? s.replace(/--to\s+\S+/, `--to ${seg.to}`) : `${s} --to ${seg.to}`;
  return s.trim().split(/\s+/);
}

export interface CacheAssistDeps {
  job: ScrapeJob;
  /** This run's output dir (where the final output.zip must land). */
  outDir: string;
  /** The done/ root, used as the cache. */
  doneDir: string;
  /** Runs the real scrape with the given EXTRA argv, writing output.zip into the
   *  given dir. Resolves with the process exit code. */
  scrape: (extraArgs: string[], outDir: string) => Promise<number>;
}

/**
 * Run a scrape, reusing chapters from a recent cached run ZIP when possible.
 * Scrapes one segment (gap or tail) per disjoint range the cache does not
 * cover, then assembles the cached reuse + every produced delta into
 * `outDir/output.zip`. Falls back to a single plain scrape (original args,
 * straight into outDir, no assembly) when nothing is cached, the job has no
 * integer `--from`, or it is a probe.
 *
 * Best-effort on segment failures: a segment that produces no output.zip (e.g.
 * ERR_EMPTY_RANGE on the tail, locked early chapters, or a transient error) is
 * skipped; the run still succeeds with the reuse + whatever deltas landed, and
 * the device re-syncs later to fill any remaining gap.
 */
export async function runScrapeWithCache(deps: CacheAssistDeps): Promise<number> {
  const { job, outDir, doneDir, scrape } = deps;
  const origExtra = job.args.trim() ? job.args.trim().split(/\s+/) : [];

  const from = job.type === "scrape" ? parseFromArg(job.args) : null;
  if (from === null) return scrape(origExtra, outDir);

  const index = await indexDoneZips(doneDir);
  const plan = planCacheReuse(from, index.get(job.url) ?? []);
  if (!plan) return scrape(origExtra, outDir);

  const segDirs: string[] = [];
  try {
    const deltaZips: string[] = [];
    for (const seg of plan.scrapeSegments) {
      const dir = await mkdtemp(join(tmpdir(), "verreaux-delta-"));
      segDirs.push(dir);
      await scrape(segmentArgs(job.args, seg), dir);
      const z = join(dir, "output.zip");
      if (await stat(z).then(() => true).catch(() => false)) deltaZips.push(z);
    }
    await assembleOutputZip({
      cachedZipPath: plan.cachedZip.zipPath,
      seriesFolder: plan.cachedZip.seriesFolder,
      reuseOrders: plan.reuseOrders,
      deltaZipPaths: deltaZips,
      outPath: join(outDir, "output"),
      from,
    });
    return 0;
  } finally {
    for (const d of segDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx vitest run test/pi/cacheAssist.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Wire it into `scripts/pi-watcher.mjs`**

The current `runScrape` dep spawns the CLI directly into `outDir`. Refactor it to delegate to `runScrapeWithCache`, passing a `scrape(extraArgs, dir)` callback that performs the existing spawn into the given dir. Replace the `runScrape:` property in the `deps` object with:

```js
import { runScrapeWithCache } from "../dist/pi/cacheAssist.js";

// ...inside `deps`:
  runScrape: ({ job, outDir, logPath }) => {
    const log = createWriteStream(logPath);
    const spawnScrape = (extraArgs, dir) =>
      new Promise((resolve) => {
        const argv =
          job.type === "probe"
            ? [join(here, "pi-probe.mjs"), job.url, "--out", dir]
            : [CLI, job.url, ...extraArgs, "--out", dir, "--flaresolverr", FLARESOLVERR, "--log-format", "json", "--no-color"];
        const child = spawn("node", argv, { env: { ...process.env, CI: "true" } });
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        child.on("close", (code) => resolve(code ?? 1));
        child.on("error", (err) => { log.write(`spawn error: ${err.message}\n`); resolve(1); });
      });
    // Probes never use the cache; scrapes route through cache-assist (which may
    // call spawnScrape once per gap/tail segment).
    const result =
      job.type === "probe"
        ? spawnScrape([], outDir)
        : runScrapeWithCache({ job, outDir, doneDir: dirs.done, scrape: spawnScrape });
    return Promise.resolve(result).finally(() => log.end());
  },
```

(`{ end: false }` keeps the shared log stream open across the multiple segment spawns; the wrapper closes it once when the whole job resolves.)

- [ ] **Step 6: Typecheck + run the Pi test suite**

Run: `cd /Users/JLAJ9408/Documents/Verreaux/scraper && npx tsc -p tsconfig.build.json --noEmit && npx vitest run test/pi/`
Expected: typecheck clean; all Pi tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git add src/pi/cacheAssist.ts scripts/pi-watcher.mjs test/pi/cacheAssist.test.ts
git commit -m "feat(pi): cache-assisted scraping reuses recent run ZIPs (gap-filling)

A catch-up scrape reuses in-range chapters from a recent done/ ZIP for the
same source and scrapes only the gaps + the tail, then assembles them, so
overlapping chapters are not re-fetched from the source site.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** Task 1 covers the auth item ("extend `POST /scrape` to also accept `Authorization: Bearer <deviceToken>`, reusing `resolveDevice`; OTP path stays"). Tasks 2-5 cover the Pi-side ZIP-reuse design with full **gap-filling** (index `done/` ZIPs → plan in-range reuse + gap/tail segments → scrape each segment → assemble). ✓
- **User's three cases:**
  - `cache 20–30, from 49` → no order ≥ 49 → `planCacheReuse` null → plain scrape `49..latest`, cache ignored. ✓
  - `cache 55–58, from 49` → reuse `55–58`, scrape `49–54` + `59..latest`, assemble. ✓
  - `cache 45..latest, from 49` → reuse `49..e`, scrape tail `e+1..latest` (empty if no newer) → serve `49..latest`; device prunes below 49 on its initial catch-up. ✓ (Pi trims 45–48 itself; more correct than literal "use as-is" because the tail scrape also catches chapters published since the cache.)
- **Placeholder scan:** None.
- **Type consistency:** `CachedZip` (Task 2) → `planCacheReuse` (Task 3) → `assembleOutputZip` / `runScrapeWithCache` (Tasks 4-5). `CacheReusePlan.{cachedZip,reuseOrders,scrapeSegments}` and `ScrapeSegment.{from,to}` are read identically in Task 5. `assembleOutputZip` takes `deltaZipPaths: string[]`; `runScrapeWithCache` builds that array. The `scrape(extraArgs, dir)` callback shape matches the worker's `spawnScrape`. ✓
- **Edge — sync disabled:** Task 1 — `sync` null → token path skipped → OTP-only. ✓
- **Edge — no cache / no integer `--from` / probe:** Task 5 — single plain scrape into `outDir`, identical to current behavior. ✓
- **Edge — empty/failed segment:** skipped; run still assembles reuse + landed deltas and succeeds; device re-syncs to fill any residual gap (documented best-effort trade-off — avoids wrongly failing on locked early chapters, which legitimately return ERR_EMPTY_RANGE). ✓
- **Correctness assumption:** chapter images are immutable per `(sourceUrl, order)`; a within-TTL re-upload at the source is not refreshed (documented). ✓
- **Atomicity:** `assembleOutputZip` writes `.tmp` then renames; `GET /runs/:id/output.zip` only ever sees a complete file. ✓
- **Independence:** Tasks 2-5 do not touch the scraper pipeline or `processJob`; they wrap the spawn via a tested TS orchestrator. Task 1 is independent. ✓
