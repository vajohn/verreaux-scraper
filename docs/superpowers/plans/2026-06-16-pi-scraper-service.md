# Pi Scraper Service Implementation Plan (Subsystem A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the scraper on the Raspberry Pi in Docker, fed by a file-based job queue, triggerable over LAN SSH (CLI wrapper) and an OTP-gated HTTP API, producing Verreaux ZIPs that carry a `verreaux.json` source manifest.

**Architecture:** A long-running `worker` container watches `~/verreaux/jobs/*.json` (chokidar), runs the existing CLI one job at a time, and writes results to `~/verreaux/done/<id>/`. A small dependency-light `api` container (Node `http`) writes the same job files and serves results, gated by TOTP and fronted later by Tailscale Funnel. A `flaresolverr` sidecar handles Cloudflare. Pure logic lives in testable `src/pi/*.ts` modules; `scripts/pi-*.mjs` are thin entrypoints. The Mac keeps a CLI wrapper that scp's jobs and downloads ZIPs.

**Tech Stack:** Node 22 / TypeScript (ESM, NodeNext), vitest, chokidar, Node `http`, Docker + compose, `mcr.microsoft.com/playwright` base image, existing `archiver`-based packager.

**Spec:** `docs/superpowers/specs/2026-06-16-scraper-pi-migration-design.md`
**Scope:** This is Subsystem A only. The PWA changes (`sourceUrl`, Dexie v5, dual import, update-from-source, back-fill) are a separate plan in the `verreaux` repo.

> **➡️ When this plan is fully implemented and Task 14 E2E has passed, continue to Plan B (Subsystem B — PWA):** `app/docs/superpowers/plans/2026-06-16-pwa-source-url-and-update.md`. Plan B depends on this plan's `verreaux.json` manifest (Task 4) and HTTP API contract (Task 7) — record the Funnel URL from Task 14 Step 6 for Plan B's API config.

---

## File Structure

**New — testable pure modules (`src/pi/`):**
- `src/pi/job.ts` — `ScrapeJob` type, `generateJobId`, `parseJob`, `serializeJob`.
- `src/pi/status.ts` — `RunStatus` type, `runningStatus`, `finalStatus`.
- `src/pi/manifest.ts` — `VerreauxManifest` type, `buildManifest`.
- `src/pi/totp.ts` — `verifyTotp` (importable; mirrors `scripts/totp.mjs`).
- `src/pi/runner.ts` — `processJob(job, dirs, deps)` with injectable spawn (testable).
- `src/pi/api.ts` — `handleApiRequest(req, res, deps)` request handler (testable).

**New — thin entrypoints (`scripts/`):**
- `scripts/pi-watcher.mjs` — wires chokidar + real fs + `processJob`.
- `scripts/pi-api.mjs` — wires Node `http` server + `handleApiRequest`.
- `scripts/pi-probe.mjs` — consolidated qimanhwa diagnostic (ex-`qimanhwa-probe.yml`).
- `scripts/scrape-pi.mjs` — Mac CLI wrapper (replaces `scrape-remote.mjs`'s role).

**New — container/infra (repo root):**
- `Dockerfile` — multi-stage build of the scraper image.
- `docker-compose.yml` — `worker` + `api` + `flaresolverr`.
- `.dockerignore`.

**Modified:**
- `src/packaging/packager.ts` — embed `verreaux.json` at ZIP root when a manifest is supplied.
- `src/core/pipeline.ts:480-489` — build a manifest from config and pass it to `packager.build`.
- `package.json` — add `chokidar` dep; add `bin` for `verreaux-scrape-pi`.
- `README.md` — document the Pi path.

**New tests (`test/pi/`):** `job.test.ts`, `status.test.ts`, `manifest.test.ts`, `totp.test.ts`, `runner.test.ts`, `api.test.ts`, plus packager manifest assertions in `test/packager.test.ts`.

---

## Task 1: Job model (`src/pi/job.ts`)

**Files:**
- Create: `src/pi/job.ts`
- Test: `test/pi/job.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/job.test.ts
import { describe, it, expect } from "vitest";
import { generateJobId, parseJob, serializeJob } from "../../src/pi/job.js";

describe("job model", () => {
  it("generates a sortable id from a fixed date + suffix", () => {
    const id = generateJobId(new Date("2026-06-16T15:30:12Z"), "ab12");
    expect(id).toBe("20260616-153012-ab12");
  });

  it("round-trips a valid scrape job", () => {
    const json = serializeJob({
      id: "20260616-153012-ab12",
      type: "scrape",
      url: "https://qimanhwa.com/series/x",
      args: "--from 1 --to 10",
    });
    const job = parseJob(json);
    expect(job.type).toBe("scrape");
    expect(job.url).toBe("https://qimanhwa.com/series/x");
    expect(job.args).toBe("--from 1 --to 10");
  });

  it("defaults type to scrape and args to empty string", () => {
    const job = parseJob('{"id":"i","url":"https://x.test/s"}');
    expect(job.type).toBe("scrape");
    expect(job.args).toBe("");
  });

  it("rejects a job with a missing/invalid url", () => {
    expect(() => parseJob('{"id":"i","url":"not-a-url"}')).toThrow(/url/i);
    expect(() => parseJob('{"id":"i"}')).toThrow(/url/i);
  });

  it("rejects an unknown type", () => {
    expect(() => parseJob('{"id":"i","url":"https://x.test/s","type":"nope"}')).toThrow(/type/i);
  });

  it("rejects malformed json with a clear message", () => {
    expect(() => parseJob("{not json")).toThrow(/json/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/job.test.ts`
Expected: FAIL — cannot find module `../../src/pi/job.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/job.ts
export type JobType = "scrape" | "probe";

export interface ScrapeJob {
  id: string;
  type: JobType;
  /** Series URL. Required and must be http(s). */
  url: string;
  /** Extra CLI args, word-split downstream. May be empty. */
  args: string;
}

/** `YYYYMMDD-HHMMSS-<suffix>` in UTC. Sortable by creation time. */
export function generateJobId(at: Date, suffix: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}` +
    `-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `${stamp}-${suffix}`;
}

export function serializeJob(job: ScrapeJob): string {
  return JSON.stringify(job, null, 2);
}

export function parseJob(raw: string): ScrapeJob {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("invalid job JSON: could not parse");
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("invalid job JSON: expected an object");
  }
  const o = obj as Record<string, unknown>;

  const type = (o.type ?? "scrape") as string;
  if (type !== "scrape" && type !== "probe") {
    throw new Error(`invalid job type: ${type}`);
  }

  const url = o.url;
  if (typeof url !== "string") throw new Error("invalid job: url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid job: url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`invalid job: url must be http(s): ${url}`);
  }

  const args = typeof o.args === "string" ? o.args : "";
  const id = typeof o.id === "string" ? o.id : "";
  return { id, type, url, args };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/job.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/job.ts test/pi/job.test.ts
git commit -m "feat(pi): job model — id generation, parse/serialize, validation"
```

---

## Task 2: Run status (`src/pi/status.ts`)

**Files:**
- Create: `src/pi/status.ts`
- Test: `test/pi/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/status.test.ts
import { describe, it, expect } from "vitest";
import { runningStatus, finalStatus } from "../../src/pi/status.js";

describe("run status", () => {
  it("builds a running status with a start time", () => {
    const s = runningStatus("2026-06-16T15:30:12Z");
    expect(s.state).toBe("running");
    expect(s.startedAt).toBe("2026-06-16T15:30:12Z");
    expect(s.finishedAt).toBeNull();
    expect(s.exitCode).toBeNull();
  });

  it("marks succeeded when exit code is 0", () => {
    const s = finalStatus(runningStatus("t0"), 0, "t1");
    expect(s.state).toBe("succeeded");
    expect(s.exitCode).toBe(0);
    expect(s.finishedAt).toBe("t1");
    expect(s.startedAt).toBe("t0");
  });

  it("marks failed when exit code is non-zero", () => {
    const s = finalStatus(runningStatus("t0"), 5, "t1", "boom");
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(5);
    expect(s.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/status.ts
export type RunState = "running" | "succeeded" | "failed";

export interface RunStatus {
  state: RunState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  message: string | null;
}

export function runningStatus(startedAt: string): RunStatus {
  return { state: "running", startedAt, finishedAt: null, exitCode: null, message: null };
}

export function finalStatus(
  prev: RunStatus,
  exitCode: number,
  finishedAt: string,
  message: string | null = null,
): RunStatus {
  return {
    ...prev,
    state: exitCode === 0 ? "succeeded" : "failed",
    exitCode,
    finishedAt,
    message,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/status.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/status.ts test/pi/status.test.ts
git commit -m "feat(pi): run status model"
```

---

## Task 3: Manifest model (`src/pi/manifest.ts`)

**Files:**
- Create: `src/pi/manifest.ts`
- Test: `test/pi/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/manifest.test.ts
import { describe, it, expect } from "vitest";
import { buildManifest } from "../../src/pi/manifest.js";

describe("buildManifest", () => {
  it("captures source url, title, adapter and range", () => {
    const m = buildManifest({
      sourceUrl: "https://qimanhwa.com/series/x",
      seriesTitle: "Series X",
      adapter: "qimanhwa",
      from: 1,
      to: 42,
      generatedAt: "2026-06-16T15:30:12Z",
    });
    expect(m).toEqual({
      schema: 1,
      sourceUrl: "https://qimanhwa.com/series/x",
      seriesTitle: "Series X",
      adapter: "qimanhwa",
      chapterRange: { from: 1, to: 42 },
      generatedAt: "2026-06-16T15:30:12Z",
    });
  });

  it("serializes 'latest' as the string upper bound", () => {
    const m = buildManifest({
      sourceUrl: "https://x.test/s",
      seriesTitle: "S",
      adapter: "a",
      from: 0,
      to: "latest",
      generatedAt: "t",
    });
    expect(m.chapterRange.to).toBe("latest");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/manifest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/manifest.ts
export interface VerreauxManifest {
  schema: 1;
  sourceUrl: string;
  seriesTitle: string;
  adapter: string;
  chapterRange: { from: number; to: number | "latest" };
  generatedAt: string;
}

export interface BuildManifestInput {
  sourceUrl: string;
  seriesTitle: string;
  adapter: string;
  from: number;
  to: number | "latest";
  generatedAt: string;
}

export function buildManifest(input: BuildManifestInput): VerreauxManifest {
  return {
    schema: 1,
    sourceUrl: input.sourceUrl,
    seriesTitle: input.seriesTitle,
    adapter: input.adapter,
    chapterRange: { from: input.from, to: input.to },
    generatedAt: input.generatedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/manifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/manifest.ts test/pi/manifest.test.ts
git commit -m "feat(pi): verreaux.json manifest model"
```

---

## Task 4: Embed manifest in the ZIP (packager + pipeline)

**Files:**
- Modify: `src/packaging/packager.ts` (`PackagerBuildOpts`, `build`, `streamZip`)
- Modify: `src/core/pipeline.ts:480-489`
- Test: `test/packager.test.ts`

- [ ] **Step 1: Write the failing test** (append inside the existing `describe("Packager", …)` block in `test/packager.test.ts`; `parseZipEntries` is already defined in that file)

```ts
  it("embeds verreaux.json at the ZIP root when a manifest is supplied", async () => {
    const { readFileSync } = await import("node:fs");
    const staging = await buildStaging(tmpDir, "run-manifest", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "with-manifest"),
      seriesTitle: "Solo Leveling",
      allowPartial: true,
      manifest: {
        schema: 1,
        sourceUrl: "https://qimanhwa.com/series/solo",
        seriesTitle: "Solo Leveling",
        adapter: "qimanhwa",
        chapterRange: { from: 0, to: "latest" },
        generatedAt: "2026-06-16T15:30:12Z",
      },
    });
    const buf = readFileSync(result.path);
    const names = parseZipEntries(buf).map((e) => e.name);
    expect(names).toContain("verreaux.json");
    // It must be at the root, not nested under the series folder.
    expect(names).not.toContain("Solo Leveling/verreaux.json");
  });

  it("omits verreaux.json when no manifest is supplied", async () => {
    const { readFileSync } = await import("node:fs");
    const staging = await buildStaging(tmpDir, "run-nomanifest", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "no-manifest"),
      seriesTitle: "Solo Leveling",
      allowPartial: true,
    });
    const names = parseZipEntries(readFileSync(result.path)).map((e) => e.name);
    expect(names).not.toContain("verreaux.json");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/packager.test.ts`
Expected: FAIL — `manifest` not assignable to `PackagerBuildOpts` (type error) / `verreaux.json` not found.

- [ ] **Step 3: Implement — extend the packager**

In `src/packaging/packager.ts`, add the import and the opts field:

```ts
import type { VerreauxManifest } from "../pi/manifest.js";
```

Add to `PackagerBuildOpts` (after `expectedPagesPerChapter?`):

```ts
  /**
   * When supplied, a `verreaux.json` file carrying source provenance is written
   * at the ZIP root (alongside the series folder, not inside it).
   */
  manifest?: VerreauxManifest;
```

Change the `streamZip` signature to receive the manifest and append it first. Update the call in `build` from:

```ts
      const { chapterCount, pageCount } = await this.streamZip(
        stagingDir,
        seriesFolder,
        chapterNames,
        tmpPath,
      );
```

to:

```ts
      const { chapterCount, pageCount } = await this.streamZip(
        stagingDir,
        seriesFolder,
        chapterNames,
        tmpPath,
        opts.manifest,
      );
```

Update the `streamZip` declaration and add the manifest entry right after `archive.pipe(output);`:

```ts
  private async streamZip(
    stagingDir: StagingDir,
    seriesFolder: string,
    chapterNames: readonly string[],
    tmpPath: string,
    manifest?: VerreauxManifest,
  ): Promise<{ chapterCount: number; pageCount: number }> {
```

```ts
    archive.pipe(output);

    // Root-level provenance manifest (small JSON → DEFLATE). Lives at the ZIP
    // root, NOT inside seriesFolder, so importers can read it before walking
    // the series tree.
    if (manifest) {
      archive.append(JSON.stringify(manifest, null, 2), {
        name: "verreaux.json",
        store: false,
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/packager.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Thread the manifest from the pipeline**

In `src/core/pipeline.ts`, add near the other packaging imports (top of file):

```ts
import { buildManifest } from "../pi/manifest.js";
```

Replace the `packager.build` call at lines 485-489 with:

```ts
      zipResult = await packager.build(staging, {
        outPath,
        seriesTitle: resolvedSeries.seriesTitle,
        allowPartial: config.allowPartialZip,
        manifest: buildManifest({
          sourceUrl: config.seriesUrl,
          seriesTitle: resolvedSeries.seriesTitle,
          adapter: adapter.id,
          from: config.from,
          to: config.to,
          generatedAt: new Date().toISOString(),
        }),
      });
```

(`adapter` is already in scope at `pipeline.ts:117`; `config.from`/`config.to` are the validated range.)

- [ ] **Step 6: Build + full test run to verify nothing regressed**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/packaging/packager.ts src/core/pipeline.ts test/packager.test.ts
git commit -m "feat(pi): embed verreaux.json source manifest in output ZIP"
```

---

## Task 5: TOTP verify (`src/pi/totp.ts`)

**Files:**
- Create: `src/pi/totp.ts`
- Test: `test/pi/totp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/totp.test.ts
import { describe, it, expect } from "vitest";
import { totp, verifyTotp } from "../../src/pi/totp.js";

const SECRET = "JBSWY3DPEHPK3PXP"; // RFC-style base32 test secret

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/totp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (mirrors the proven algorithm in `scripts/totp.mjs`)

```ts
// src/pi/totp.ts
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

export function verifyTotp(secretBase32: string, code: string, atMs: number): boolean {
  const c = String(code).trim();
  for (const drift of [-1, 0, 1]) {
    if (totp(secretBase32, atMs + drift * 30_000) === c) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/totp.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/totp.ts test/pi/totp.test.ts
git commit -m "feat(pi): importable TOTP verify for the API gate"
```

---

## Task 6: Job runner core (`src/pi/runner.ts`)

The runner is the heart of the worker, with an **injectable** spawn + clock + fs so it is fully unit-testable without Docker or a real scrape.

**Files:**
- Create: `src/pi/runner.ts`
- Test: `test/pi/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/runner.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processJob } from "../../src/pi/runner.js";
import type { RunnerDeps } from "../../src/pi/runner.js";

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-"));
  const jobs = join(root, "jobs");
  const done = join(root, "done");
  const state = join(root, "state");
  for (const d of [jobs, done, state]) require("node:fs").mkdirSync(d);
  return { root, jobs, done, state };
}

const baseDeps = (exitCode: number): RunnerDeps => ({
  now: () => "2026-06-16T15:30:12Z",
  // Fake spawn: write a marker into the run dir, then resolve with exitCode.
  runScrape: async ({ outDir }) => {
    writeFileSync(join(outDir, "ran.txt"), "ok");
    return exitCode;
  },
});

describe("processJob", () => {
  it("runs a scrape and writes a succeeded status", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j1.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j1", type: "scrape", url: "https://x.test/s", args: "--from 0 --to latest" }));

    await processJob(jobPath, dirs, baseDeps(0));

    const status = JSON.parse(readFileSync(join(dirs.done, "j1", "status.json"), "utf8"));
    expect(status.state).toBe("succeeded");
    expect(status.exitCode).toBe(0);
    expect(existsSync(join(dirs.done, "j1", "ran.txt"))).toBe(true);
    // Job file is moved aside, not left in jobs/.
    expect(readdirSync(dirs.jobs)).toEqual(["j1.json.done"]);
  });

  it("writes a failed status on non-zero exit", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j2.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j2", type: "scrape", url: "https://x.test/s" }));

    await processJob(jobPath, dirs, baseDeps(5));

    const status = JSON.parse(readFileSync(join(dirs.done, "j2", "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.exitCode).toBe(5);
    expect(readdirSync(dirs.jobs)).toEqual(["j2.json.done"]);
  });

  it("writes a failed status for an unparseable job without throwing", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "bad.json");
    writeFileSync(jobPath, "{not json");

    await expect(processJob(jobPath, dirs, baseDeps(0))).resolves.toBeUndefined();
    // A bad job is moved aside with a failed status under a derived id.
    expect(readdirSync(dirs.jobs)).toEqual(["bad.json.done"]);
    const failed = JSON.parse(readFileSync(join(dirs.done, "bad", "status.json"), "utf8"));
    expect(failed.state).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/runner.ts
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseJob, type ScrapeJob } from "./job.js";
import { runningStatus, finalStatus, type RunStatus } from "./status.js";

export interface RunnerDirs {
  jobs: string;
  done: string;
  state: string;
}

export interface RunScrapeArgs {
  job: ScrapeJob;
  outDir: string;
  logPath: string;
}

export interface RunnerDeps {
  /** ISO timestamp source (injectable for tests). */
  now: () => string;
  /** Executes the scrape; resolves with the process exit code. */
  runScrape: (args: RunScrapeArgs) => Promise<number>;
}

async function writeStatus(doneDir: string, status: RunStatus): Promise<void> {
  await writeFile(join(doneDir, "status.json"), JSON.stringify(status, null, 2));
}

/**
 * Process a single job file end-to-end. Never throws: any failure is recorded
 * as a `failed` status so the watcher loop keeps running.
 */
export async function processJob(
  jobPath: string,
  dirs: RunnerDirs,
  deps: RunnerDeps,
): Promise<void> {
  // Derive a fallback id from the filename so even an unparseable job lands
  // in a predictable done/<id>/ dir.
  const fallbackId = basename(jobPath).replace(/\.json(\.processing)?$/, "");

  let job: ScrapeJob;
  try {
    job = parseJob(readFileSync(jobPath, "utf8"));
    if (!job.id) job.id = fallbackId;
  } catch (err) {
    const doneDir = join(dirs.done, fallbackId);
    await mkdir(doneDir, { recursive: true });
    const started = runningStatus(deps.now());
    await writeStatus(
      doneDir,
      finalStatus(started, 2, deps.now(), err instanceof Error ? err.message : String(err)),
    );
    await rename(jobPath, join(dirs.jobs, `${fallbackId}.json.done`)).catch(() => undefined);
    return;
  }

  const doneDir = join(dirs.done, job.id);
  await mkdir(doneDir, { recursive: true });

  const started = runningStatus(deps.now());
  await writeStatus(doneDir, started);

  let exitCode = 1;
  let message: string | null = null;
  try {
    exitCode = await deps.runScrape({
      job,
      outDir: doneDir,
      logPath: join(doneDir, "run.log"),
    });
  } catch (err) {
    exitCode = 1;
    message = err instanceof Error ? err.message : String(err);
  }

  await writeStatus(doneDir, finalStatus(started, exitCode, deps.now(), message));
  await rename(jobPath, join(dirs.jobs, `${job.id}.json.done`)).catch(() => undefined);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/runner.ts test/pi/runner.test.ts
git commit -m "feat(pi): job runner core with injectable spawn"
```

---

## Task 7: HTTP API core (`src/pi/api.ts`)

A single request handler over Node `http`, fully testable by starting it on an ephemeral port.

**Files:**
- Create: `src/pi/api.ts`
- Test: `test/pi/api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pi/api.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiRequest, type ApiDeps } from "../../src/pi/api.js";
import { totp } from "../../src/pi/totp.js";

const SECRET = "JBSWY3DPEHPK3PXP";

function startServer(deps: ApiDeps): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handleApiRequest(req, res, deps));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("api", () => {
  let dirs: { jobs: string; done: string; state: string };
  let ctx: { server: Server; base: string };

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-api-"));
    dirs = { jobs: join(root, "jobs"), done: join(root, "done"), state: join(root, "state") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    ctx = await startServer({
      dirs,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      newSuffix: () => "abcd",
      corsOrigin: "*",
    });
  });

  afterEach(() => ctx.server.close());

  it("rejects POST /scrape with a bad OTP (401) and writes no job", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/s", otp: "000000" }),
    });
    expect(res.status).toBe(401);
    expect(readdirSync(dirs.jobs)).toEqual([]);
  });

  it("accepts POST /scrape with a valid OTP (201) and writes a job file", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/s", args: "--from 1 --to 2", otp: totp(SECRET, 1_700_000_000_000) }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(id).toBe("20231114-221320-abcd");
    const files = readdirSync(dirs.jobs);
    expect(files).toEqual([`${id}.json`]);
    const job = JSON.parse(readFileSync(join(dirs.jobs, files[0]), "utf8"));
    expect(job.url).toBe("https://x.test/s");
    expect(job.args).toBe("--from 1 --to 2");
  });

  it("returns the status for GET /runs/:id", async () => {
    mkdirSync(join(dirs.done, "run9"));
    writeFileSync(join(dirs.done, "run9", "status.json"), JSON.stringify({ state: "succeeded" }));
    const res = await fetch(`${ctx.base}/runs/run9`);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("succeeded");
  });

  it("sets CORS headers and answers preflight", async () => {
    const res = await fetch(`${ctx.base}/scrape`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/pi/api.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateJobId, serializeJob, parseJob } from "./job.js";
import { verifyTotp } from "./totp.js";
import type { RunnerDirs } from "./runner.js";

export interface ApiDeps {
  dirs: RunnerDirs;
  secret: string;
  now: () => number;
  /** Random id suffix (injectable for deterministic tests). */
  newSuffix: () => string;
  corsOrigin: string;
}

function cors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  cors(res, deps.corsOrigin);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // POST /scrape { url, args?, type?, otp }
  if (req.method === "POST" && path === "/scrape") {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    if (!verifyTotp(deps.secret, String(payload.otp ?? ""), deps.now())) {
      return json(res, 401, { error: "invalid authenticator code" });
    }
    const id = generateJobId(new Date(deps.now()), deps.newSuffix());
    let jobJson: string;
    try {
      jobJson = serializeJob(
        parseJob(
          JSON.stringify({
            id,
            type: payload.type ?? "scrape",
            url: payload.url,
            args: payload.args ?? "",
          }),
        ),
      );
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    await writeFile(join(deps.dirs.jobs, `${id}.json`), jobJson);
    return json(res, 201, { id });
  }

  // GET /runs/:id  and  GET /runs/:id/output.zip  and  GET /runs/:id/log
  const runMatch = path.match(/^\/runs\/([^/]+)(\/output\.zip|\/log)?$/);
  if (req.method === "GET" && runMatch) {
    const id = runMatch[1]!;
    const sub = runMatch[2];
    const runDir = join(deps.dirs.done, id);
    try {
      if (sub === "/output.zip") {
        const { readdir } = await import("node:fs/promises");
        const files = (await readdir(runDir)).filter((f) => f.endsWith(".zip"));
        if (files.length === 0) return json(res, 404, { error: "no zip yet" });
        res.statusCode = 200;
        res.setHeader("content-type", "application/zip");
        res.setHeader("content-disposition", `attachment; filename="${files[0]}"`);
        createReadStream(join(runDir, files[0]!)).pipe(res);
        return;
      }
      if (sub === "/log") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        createReadStream(join(runDir, "run.log")).on("error", () => res.end()).pipe(res);
        return;
      }
      const status = await readFile(join(runDir, "status.json"), "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(status);
      return;
    } catch {
      return json(res, 404, { error: "run not found" });
    }
  }

  json(res, 404, { error: "not found" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pi/api.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/api.ts test/pi/api.test.ts
git commit -m "feat(pi): OTP-gated HTTP API handler (scrape + runs + zip)"
```

---

## Task 8: Add `chokidar` dep + watcher entrypoint (`scripts/pi-watcher.mjs`)

**Files:**
- Modify: `package.json` (add `chokidar`)
- Create: `scripts/pi-watcher.mjs`

- [ ] **Step 1: Add the dependency**

Run: `npm install chokidar@^4.0.0`
Expected: `chokidar` appears under `dependencies` in `package.json`; lockfile updates.

- [ ] **Step 2: Write the entrypoint** (thin wiring; the logic it calls is already tested in Task 6)

```js
// scripts/pi-watcher.mjs
// Long-running worker entrypoint. Watches jobs/*.json, processes one at a time
// via the tested processJob core, spawning the built CLI for real scrapes.
import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, renameSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processJob } from "../dist/pi/runner.js";

const ROOT = process.env.VERREAUX_ROOT ?? "/work";
const dirs = { jobs: join(ROOT, "jobs"), done: join(ROOT, "done"), state: join(ROOT, "state") };
const FLARESOLVERR = process.env.FLARESOLVERR_URL ?? "http://flaresolverr:8191/v1";
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli", "index.js");

const deps = {
  now: () => new Date().toISOString(),
  runScrape: ({ job, outDir, logPath }) =>
    new Promise((resolve) => {
      const log = createWriteStream(logPath);
      // EXTRA args word-split intentionally, matching the old GitHub job.
      const extra = job.args.length ? job.args.split(/\s+/) : [];
      const argv =
        job.type === "probe"
          ? [join(here, "pi-probe.mjs"), job.url, "--out", outDir]
          : [CLI, job.url, ...extra, "--out", outDir, "--flaresolverr", FLARESOLVERR, "--log-format", "json", "--no-color"];
      const child = spawn("node", argv, { env: { ...process.env, CI: "true" } });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err) => {
        log.write(`spawn error: ${err.message}\n`);
        resolve(1);
      });
    }),
};

// Serial queue: never run two scrapes at once.
let chain = Promise.resolve();
function enqueue(jobPath) {
  chain = chain.then(() => processJob(jobPath, dirs, deps).catch((e) => console.error("processJob crashed:", e)));
}

// Orphan recovery: anything left in *.processing from a crash is failed out.
async function recoverOrphans() {
  for (const f of readdirSync(dirs.jobs).filter((f) => f.endsWith(".json.processing"))) {
    const id = f.replace(/\.json\.processing$/, "");
    const doneDir = join(dirs.done, id);
    await mkdir(doneDir, { recursive: true }).catch(() => {});
    await writeFile(
      join(doneDir, "status.json"),
      JSON.stringify({ state: "failed", message: "interrupted by restart", exitCode: 1, startedAt: null, finishedAt: new Date().toISOString() }, null, 2),
    ).catch(() => {});
    if (existsSync(join(dirs.jobs, f))) renameSync(join(dirs.jobs, f), join(dirs.jobs, `${id}.json.done`));
  }
}

await recoverOrphans();
console.log(`[pi-watcher] watching ${dirs.jobs}`);
chokidar
  .watch(`${dirs.jobs}/*.json`, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 500 } })
  .on("add", (p) => {
    if (p.endsWith(".json") && !p.endsWith(".processing") && !p.endsWith(".done")) enqueue(p);
  });
```

- [ ] **Step 3: Smoke-test the entrypoint locally with a stub CLI**

Run:
```bash
npm run build
mkdir -p /tmp/vw/{jobs,done,state}
VERREAUX_ROOT=/tmp/vw node scripts/pi-watcher.mjs &
WATCHER_PID=$!
echo '{"id":"smoke1","type":"scrape","url":"https://manhwanex.com/series/does-not-exist"}' > /tmp/vw/jobs/smoke1.json
sleep 8
cat /tmp/vw/done/smoke1/status.json
kill $WATCHER_PID
```
Expected: `done/smoke1/status.json` exists with `state` `succeeded` or `failed` (either proves the watcher → runner → CLI wiring fired); `jobs/` ends with `smoke1.json.done`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json scripts/pi-watcher.mjs
git commit -m "feat(pi): chokidar watcher entrypoint with serial queue + orphan recovery"
```

---

## Task 9: API entrypoint (`scripts/pi-api.mjs`)

**Files:**
- Create: `scripts/pi-api.mjs`

- [ ] **Step 1: Write the entrypoint**

```js
// scripts/pi-api.mjs
// HTTP API entrypoint. Wires Node http to the tested handleApiRequest core.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { handleApiRequest } from "../dist/pi/api.js";

const ROOT = process.env.VERREAUX_ROOT ?? "/work";
const SECRET = process.env.SCRAPE_TOTP_SECRET;
if (!SECRET) {
  console.error("SCRAPE_TOTP_SECRET is required");
  process.exit(1);
}
const deps = {
  dirs: { jobs: join(ROOT, "jobs"), done: join(ROOT, "done"), state: join(ROOT, "state") },
  secret: SECRET,
  now: () => Date.now(),
  newSuffix: () => randomBytes(2).toString("hex"),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};
const PORT = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  handleApiRequest(req, res, deps).catch((err) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err?.message ?? "internal error" }));
  });
}).listen(PORT, () => console.log(`[pi-api] listening on :${PORT}`));
```

- [ ] **Step 2: Smoke-test against a real secret**

Run:
```bash
npm run build
mkdir -p /tmp/vw/{jobs,done,state}
SECRET=$(node scripts/totp.mjs gen | awk '/secret:/{print $2}')
VERREAUX_ROOT=/tmp/vw SCRAPE_TOTP_SECRET=$SECRET PORT=8080 node scripts/pi-api.mjs &
API_PID=$!
sleep 1
OTP=$(SCRAPE_TOTP_SECRET=$SECRET node scripts/totp.mjs now)
curl -s -X POST localhost:8080/scrape -H 'content-type: application/json' \
  -d "{\"url\":\"https://manhwanex.com/series/x\",\"otp\":\"$OTP\"}"
echo; ls /tmp/vw/jobs
kill $API_PID
```
Expected: JSON `{"id":"..."}`; a matching `<id>.json` in `/tmp/vw/jobs`.

- [ ] **Step 3: Commit**

```bash
git add scripts/pi-api.mjs
git commit -m "feat(pi): HTTP API entrypoint"
```

---

## Task 10: Consolidated probe (`scripts/pi-probe.mjs`)

Port the four `qimanhwa-probe.yml` jobs into one script that writes artifacts to `--out`.

**Files:**
- Create: `scripts/pi-probe.mjs`

- [ ] **Step 1: Write the script**

```js
// scripts/pi-probe.mjs
// Consolidated qimanhwa diagnostic (was qimanhwa-probe.yml). Writes a
// classification + captured DOM/JSON/screenshot into --out for inspection.
// Usage: node scripts/pi-probe.mjs <url> --out <dir>
import { addExtra } from "playwright-extra";
import { chromium as base } from "playwright";
import Stealth from "puppeteer-extra-plugin-stealth";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2] ?? "https://qimanhwa.com/";
const outIdx = process.argv.indexOf("--out");
const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : "./probe-out";
mkdirSync(outDir, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const chromium = addExtra(base);
chromium.use(Stealth());

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const apiHits = [];
page.on("response", async (resp) => {
  const u = resp.url();
  if (/\/api\//i.test(u)) {
    let body = "";
    if (/json/i.test(resp.headers()["content-type"] || "")) {
      try { body = (await resp.text()).slice(0, 4000); } catch {}
    }
    apiHits.push({ url: u, status: resp.status() });
    if (body) writeFileSync(join(outDir, `api_${u.replace(/[^a-z0-9]+/gi, "_").slice(-60)}.json`), body);
  }
});

let verdict = "ERROR";
try {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const status = resp ? resp.status() : "no-response";
  await page.waitForTimeout(8000);
  const title = await page.title();
  const bodyText = (await page.evaluate(() => document.body?.innerText || "")).slice(0, 300);
  const isChallenge = /just a moment|verify you are human|cf-chl|challenge/i.test(title + " " + bodyText);
  await page.screenshot({ path: join(outDir, "screenshot.png") });
  writeFileSync(join(outDir, "home.html"), await page.content());
  verdict = isChallenge ? "BLOCKED — Cloudflare challenge" : /manhwa/i.test(title) ? "SUCCESS — content rendered" : "INCONCLUSIVE";
  console.log(JSON.stringify({ status, title, verdict, apiHits: apiHits.length }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ verdict: "ERROR", message: err.message }, null, 2));
} finally {
  writeFileSync(join(outDir, "_requests.json"), JSON.stringify(apiHits, null, 2));
  await browser.close();
}
// Exit 0 even on a block — a probe "result" is success for the worker.
process.exit(0);
```

- [ ] **Step 2: Commit** (no unit test — it is a network diagnostic; verified in the Task 13 E2E)

```bash
git add scripts/pi-probe.mjs
git commit -m "feat(pi): consolidated qimanhwa diagnostic probe"
```

---

## Task 11: Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
output
.git
test
tmp
qa-evidence
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# Native ARM64 build on the Pi. The Playwright base ships Chromium + system deps
# for the matching arch, so we avoid a separate `install --with-deps`.
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript (includes dist/pi/* and dist/cli/*).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# The Chromium the base image ships is what Playwright uses.
ENV VERREAUX_ROOT=/work
RUN mkdir -p /work/jobs /work/done /work/state

# Default to the worker; compose overrides command for the api service.
CMD ["node", "scripts/pi-watcher.mjs"]
```

- [ ] **Step 3: Verify the image builds (run on the Pi or any arm64/amd64 Docker host)**

Run: `docker build -t verreaux-scraper:dev .`
Expected: build completes; final image tagged `verreaux-scraper:dev`. (Note: native deps `better-sqlite3`/`sharp` compile during `npm ci`/build — confirm no node-gyp failure.)

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(pi): Dockerfile (playwright base) + dockerignore"
```

---

## Task 12: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Write the compose file**

```yaml
services:
  worker:
    build: .
    image: verreaux-scraper:dev
    restart: unless-stopped
    environment:
      VERREAUX_ROOT: /work
      FLARESOLVERR_URL: http://flaresolverr:8191/v1
    volumes:
      - ./data/jobs:/work/jobs
      - ./data/done:/work/done
      - ./data/state:/work/state
    depends_on:
      - flaresolverr
    command: ["node", "scripts/pi-watcher.mjs"]

  api:
    image: verreaux-scraper:dev
    restart: unless-stopped
    environment:
      VERREAUX_ROOT: /work
      PORT: "8080"
      CORS_ORIGIN: ${CORS_ORIGIN:-*}
      SCRAPE_TOTP_SECRET: ${SCRAPE_TOTP_SECRET:?set SCRAPE_TOTP_SECRET in .env}
    volumes:
      - ./data/jobs:/work/jobs
      - ./data/done:/work/done
      - ./data/state:/work/state
    ports:
      - "8080:8080"
    command: ["node", "scripts/pi-api.mjs"]

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    restart: unless-stopped
    environment:
      LOG_LEVEL: info
```

- [ ] **Step 2: Validate compose config**

Run: `SCRAPE_TOTP_SECRET=dummy docker compose config`
Expected: prints the resolved config with all three services, no errors.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(pi): compose stack — worker + api + flaresolverr"
```

---

## Task 13: Mac CLI wrapper (`scripts/scrape-pi.mjs`)

**Files:**
- Create: `scripts/scrape-pi.mjs`
- Modify: `package.json` (`bin.verreaux-scrape-pi`)
- Test: `test/pi/scrape-pi-cli.test.ts`

- [ ] **Step 1: Write the failing test** (covers the testable `buildCommands` planner; the network/ssh wiring is exercised manually)

```ts
// test/pi/scrape-pi-cli.test.ts
import { describe, it, expect } from "vitest";
import { buildCommands } from "../../scripts/scrape-pi-lib.mjs";

describe("scrape-pi command planner", () => {
  it("plans scp upload, status poll, and zip download for a host", () => {
    const c = buildCommands({
      host: "pajohn.local",
      user: "vajohn",
      id: "20260616-153012-abcd",
      localJobPath: "/tmp/20260616-153012-abcd.json",
      outDir: "./output",
    });
    expect(c.upload).toEqual(["scp", "/tmp/20260616-153012-abcd.json", "vajohn@pajohn.local:~/verreaux/data/jobs/20260616-153012-abcd.json"]);
    expect(c.status).toEqual(["ssh", "vajohn@pajohn.local", "cat ~/verreaux/data/done/20260616-153012-abcd/status.json"]);
    expect(c.download).toEqual(["scp", "vajohn@pajohn.local:~/verreaux/data/done/20260616-153012-abcd/*.zip", "./output/"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pi/scrape-pi-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the planner lib + entrypoint**

```js
// scripts/scrape-pi-lib.mjs
// Pure command planner — kept separate so it is unit-testable without SSH.
export function buildCommands({ host, user, id, localJobPath, outDir, remoteRoot = "~/verreaux/data" }) {
  const target = `${user}@${host}`;
  return {
    upload: ["scp", localJobPath, `${target}:${remoteRoot}/jobs/${id}.json`],
    status: ["ssh", target, `cat ${remoteRoot}/done/${id}/status.json`],
    log: ["ssh", target, `tail -n 40 ${remoteRoot}/done/${id}/run.log`],
    download: ["scp", `${target}:${remoteRoot}/done/${id}/*.zip`, `${outDir}/`],
  };
}
```

```js
// scripts/scrape-pi.mjs
#!/usr/bin/env node
// Mac-side wrapper: scp a job to the Pi over LAN SSH, poll status, download ZIPs.
// Usage: verreaux-scrape-pi <series-url> [-- <extra cli args>] [--probe] [--dry-run]
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildCommands } from "./scrape-pi-lib.mjs";

const HOST = process.env.PI_HOST ?? "pajohn.local";
const USER = process.env.PI_USER ?? "vajohn";
const OUT = "./output";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const probe = argv.includes("--probe");
const url = argv.find((a) => !a.startsWith("-"));
if (!url) { console.error("usage: verreaux-scrape-pi <series-url> [-- <args>] [--probe] [--dry-run]"); process.exit(2); }
const sep = argv.indexOf("--");
const extra = sep === -1 ? "--from 0 --to latest" : argv.slice(sep + 1).join(" ");

const now = new Date();
const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
const id = `${stamp}-${randomBytes(2).toString("hex")}`;
const localJobPath = join(tmpdir(), `${id}.json`);
writeFileSync(localJobPath, JSON.stringify({ id, type: probe ? "probe" : "scrape", url, args: extra }, null, 2));

const cmds = buildCommands({ host: HOST, user: USER, id, localJobPath, outDir: OUT });

if (dryRun) { console.log(JSON.stringify(cmds, null, 2)); process.exit(0); }

mkdirSync(OUT, { recursive: true });
console.log(`Uploading job ${id} to ${USER}@${HOST}…`);
execFileSync(cmds.upload[0], cmds.upload.slice(1), { stdio: "inherit" });

console.log("Running remotely; polling…");
const deadline = Date.now() + 120 * 60 * 1000;
let state = "running";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10000));
  const out = spawnSync(cmds.status[0], cmds.status.slice(1), { encoding: "utf8" });
  if (out.status === 0) {
    try { state = JSON.parse(out.stdout).state; } catch {}
    process.stdout.write(`  state=${state}\r`);
    if (state === "succeeded" || state === "failed") break;
  }
}
console.log(`\nFinal state: ${state}`);
if (state !== "succeeded") {
  spawnSync(cmds.log[0], cmds.log.slice(1), { stdio: "inherit" });
  process.exit(1);
}
execFileSync(cmds.download[0], cmds.download.slice(1), { stdio: "inherit", shell: true });
console.log(`Done. Saved to ${OUT}/`);
```

- [ ] **Step 4: Add the bin entry to `package.json`**

In the `"bin"` block, add:
```json
    "verreaux-scrape-pi": "./scripts/scrape-pi.mjs"
```

- [ ] **Step 5: Run test + dry-run to verify**

Run: `npx vitest run test/pi/scrape-pi-cli.test.ts && node scripts/scrape-pi.mjs https://manhwanex.com/series/x -- --from 1 --to 2 --dry-run`
Expected: test PASS; dry-run prints the upload/status/log/download command arrays.

- [ ] **Step 6: Commit**

```bash
git add scripts/scrape-pi.mjs scripts/scrape-pi-lib.mjs test/pi/scrape-pi-cli.test.ts package.json
git commit -m "feat(pi): Mac CLI wrapper (scp job + poll + download)"
```

---

## Task 14: One-time Pi setup + end-to-end validation

**Files:** none (operational). Documented here so the deployer has exact commands.

- [ ] **Step 1: Enable key-based SSH (one time, uses the password once)**

Run (from the Mac, on the home LAN):
```bash
ssh-copy-id vajohn@pajohn.local
```
Expected: prompts for `PI_4_PASSWORD` once; afterwards `ssh vajohn@pajohn.local true` succeeds with no password.

- [ ] **Step 2: Put the repo + data dirs on the Pi**

Run (on the Pi):
```bash
git clone https://github.com/vajohn/verreaux-scraper.git ~/verreaux && cd ~/verreaux
mkdir -p data/jobs data/done data/state
node scripts/totp.mjs gen   # save the secret + otpauth URI into your authenticator
printf "SCRAPE_TOTP_SECRET=<secret>\nCORS_ORIGIN=*\n" > .env
```
Expected: repo cloned; `.env` holds the TOTP secret.

- [ ] **Step 3: Build + start the stack**

Run (on the Pi): `docker compose build && docker compose up -d && docker compose ps`
Expected: `worker`, `api`, `flaresolverr` all `running`.

- [ ] **Step 4: E2E via the CLI against the no-Cloudflare control**

Run (from the Mac): `node scripts/scrape-pi.mjs https://manhwanex.com/series/<known-slug> -- --from 1 --to 2`
Expected: state reaches `succeeded`; a `.zip` lands in `./output/`. Verify the manifest:
```bash
unzip -l ./output/*.zip | grep verreaux.json
unzip -p ./output/*.zip verreaux.json
```
Expected: `verreaux.json` present with the correct `sourceUrl`.

- [ ] **Step 5: E2E via the HTTP API + the real target**

Run (from the Mac, with the Pi `SCRAPE_TOTP_SECRET` exported locally to mint a code):
```bash
OTP=$(SCRAPE_TOTP_SECRET=<secret> node scripts/totp.mjs now)
curl -s -X POST http://pajohn.local:8080/scrape -H 'content-type: application/json' \
  -d "{\"url\":\"https://qimanhwa.com/series/<slug>\",\"args\":\"--from 0 --to 2\",\"otp\":\"$OTP\"}"
```
Poll `GET http://pajohn.local:8080/runs/<id>` until `succeeded`, then `GET .../output.zip`.
Expected: a ZIP downloads; qimanhwa scrape succeeds from the Pi's clean egress (FlareSolverr clears Cloudflare).

- [ ] **Step 6: (Optional) expose the API for the PWA**

Run (on the Pi): `tailscale funnel 8080`
Expected: prints a public `https://<host>.<tailnet>.ts.net` URL — record it for the PWA plan (Subsystem B).

---

## Task 15: Documentation + GitHub workflow retirement

**Files:**
- Modify: `README.md`
- Delete: `.github/workflows/scrape.yml`, `.github/workflows/qimanhwa-probe.yml`, `scripts/scrape-remote.mjs`

- [ ] **Step 1: Update the README** — replace the "Remote scrape (GitHub Actions)" section with a "Scrape on the Pi" section documenting: the `verreaux-scrape-pi` wrapper, `PI_HOST`/`PI_USER` env, the compose stack, the OTP-gated API, and that `verreaux.json` is embedded in every ZIP. Keep the FlareSolverr note.

- [ ] **Step 2: Remove the GitHub job ONLY after Task 14 E2E passed**

```bash
git rm .github/workflows/scrape.yml .github/workflows/qimanhwa-probe.yml scripts/scrape-remote.mjs
```
(Keep `scripts/totp.mjs` — still used to mint codes for the API; and `src/pi/totp.ts` is its importable twin.)

- [ ] **Step 3: Full verification**

Run: `npm run build && npx vitest run && npm run lint`
Expected: build, all tests, and lint PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git rm --cached .github/workflows/scrape.yml .github/workflows/qimanhwa-probe.yml scripts/scrape-remote.mjs 2>/dev/null || true
git commit -m "docs(pi): document Pi path; retire GitHub Actions scrape + probe"
```

---

## Self-Review

**Spec coverage:**
- Drop-folder queue (jobs/done) → Tasks 1, 6, 8. ✓
- In-process worker, serial → Task 8 (serial chain). ✓
- FlareSolverr sidecar → Task 12. ✓
- CLI over LAN SSH/scp → Task 13. ✓
- HTTP API + OTP gate + CORS → Tasks 5, 7, 9. ✓
- Funnel exposure → Task 14 Step 6. ✓
- `verreaux.json` manifest (carries sourceUrl) → Tasks 3, 4. ✓
- Probe ported → Task 10. ✓
- Native ARM64 build → Task 11. ✓
- Key-based SSH setup → Task 14 Step 1. ✓
- Orphan recovery on restart → Task 8 (`recoverOrphans`). ✓
- Bad-job-JSON → failed status without crashing → Task 6 test 3. ✓
- Retirement of GH workflows → Task 15. ✓
- E2E manhwanex control then qimanhwa → Task 14. ✓
- **PWA-side items (sourceUrl field, Dexie v5, dual import, update-from-source, back-fill)** → intentionally a SEPARATE plan (Subsystem B), per the scope note.

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓
**Type consistency:** `RunnerDirs` (jobs/done/state) shared by `runner.ts`, `api.ts`, entrypoints; `RunStatus` shape consistent across `status.ts`, runner, api test; `VerreauxManifest` consistent across `manifest.ts`, packager, pipeline. `buildCommands` signature matches its test. ✓
**Note:** remote data dirs are `~/verreaux/data/{jobs,done}` (compose bind mounts), which is what the CLI wrapper's `remoteRoot` targets — kept consistent between Task 12 and Task 13.
