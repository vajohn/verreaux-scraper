# manhwanex + qimanhwa Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new source adapters — `manhwanex.com` (Madara WordPress, plain HTTP) and `qimanhwa.com` (Angular SSR SPA, parsed from its embedded `ng-state` data) — plus a GitHub-Actions workflow to run the scraper off the Zscaler-filtered corporate network.

**Architecture:** manhwanex parses server-rendered Madara HTML via `cheerio` (mirrors the existing drake adapter). qimanhwa renders each page through the existing `BrowserPool` (headless on CI clears Cloudflare), then extracts the Angular TransferState JSON blob (`<script id="ng-state">`), which the SSR server populates with the site's REST API responses (series metadata, chapter list, and the full per-chapter image list). No new runtime dependencies.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `cheerio`, `vitest`, Playwright (via existing `BrowserPool`), GitHub Actions.

**Source of truth:** the approved spec at `docs/superpowers/specs/2026-06-08-manhwanex-qimanhwa-adapters-design.md`. All expected test values below were captured from the live sites on 2026-06-08 (manhwanex locally; qimanhwa via the `qimanhwa-probe` GitHub Actions workflow).

---

## Conventions in this codebase (read before starting)

- ESM with NodeNext: **all relative imports end in `.js`** even though sources are `.ts` (e.g. `import { foo } from "./bar.js"`).
- Adapters come in pairs: `src/adapters/<id>.ts` (the `SourceAdapter` class) + `src/adapters/<id>.helpers.ts` (pure, side-effect-free parsers). Tests live in `test/<id>.adapter.test.ts` and `test/<id>.helpers.test.ts`. Fixtures in `test/fixtures/<id>/`.
- `SourceAdapter` interface is in `src/core/types.ts`. The registry is `src/adapters/index.ts`.
- Adapter context API used below:
  - `ctx.http.get(url, { referer?, signal? }): Promise<{ statusCode: number; body: string }>`
  - `ctx.http.getJson<T>(url, { referer?, signal? }): Promise<T>`
  - `ctx.http.post(url, { form?, referer?, signal? }): Promise<{ statusCode: number; body: string }>`
  - `ctx.browser.renderPage(url, { waitForSelector?, state?, timeoutMs? }): Promise<string>` (returns hydrated HTML; reuses a per-host context that clears Cloudflare)
  - `ctx.signal: AbortSignal`, `ctx.logger` (pino).
- `ChapterStub = { chapterNumber: number; chapterTitle: string | null; chapterUrl: string }`.
- `PageStub = { pageIndex: number; imageUrl: string; referer: string }`.
- Run the full suite with `npm test` (vitest). Run one file with `npx vitest run test/<file>`.
- Commit messages: conventional commits (`feat:`, `test:`, `docs:`, `ci:`).

---

## File Structure

**Create:**
- `src/adapters/manhwanex.helpers.ts` — pure Madara parsers (title, cover, chapter list, reader images, post-id).
- `src/adapters/manhwanex.ts` — `ManhwanexAdapter` class + `manhwanexAdapter` singleton.
- `src/adapters/qimanhwa.helpers.ts` — `ng-state` extractor + JSON mappers (chapter list, images, series meta).
- `src/adapters/qimanhwa.ts` — `QimanhwaAdapter` class + `qimanhwaAdapter` singleton.
- `test/manhwanex.helpers.test.ts`, `test/manhwanex.adapter.test.ts`
- `test/qimanhwa.helpers.test.ts`, `test/qimanhwa.adapter.test.ts`
- `test/fixtures/manhwanex/series.html`, `test/fixtures/manhwanex/chapter.html`
- `test/fixtures/qimanhwa/series.html`, `test/fixtures/qimanhwa/chapter.html`
- `scripts/totp.mjs` — RFC 6238 TOTP validator (gate for the scrape workflow) + `test/totp.test.ts`.
- `scripts/scrape-remote.mjs` — local wrapper: prompt code → dispatch workflow → download ZIP to `./output`.
- `.github/workflows/scrape.yml` — run the scraper CLI on a GitHub runner, TOTP-gated.
- `.github/CODEOWNERS` — require owner review for the workflow + TOTP validator (Task 10).

**Modify:**
- `src/core/types.ts` — extend the `SourceAdapter["id"]` union.
- `src/adapters/index.ts` — register both new adapters.
- `README.md` — Supported sources table + Zscaler note.

---

## Task 1: Branch and capture test fixtures

**Files:**
- Create: `test/fixtures/manhwanex/series.html`, `test/fixtures/manhwanex/chapter.html`
- Create: `test/fixtures/qimanhwa/series.html`, `test/fixtures/qimanhwa/chapter.html`

- [ ] **Step 1: Create a feature branch**

```bash
cd /Users/JLAJ9408/Documents/Verreaux/scraper
git checkout -b feat/manhwanex-qimanhwa-adapters
mkdir -p test/fixtures/manhwanex test/fixtures/qimanhwa
```

- [ ] **Step 2: Capture manhwanex fixtures (site is reachable directly)**

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
curl -sS -A "$UA" "https://manhwanex.com/manga/sss-grade-saint-knight/" -o test/fixtures/manhwanex/series.html
# Pick the lowest chapter from the series page for a stable fixture:
curl -sS -A "$UA" "https://manhwanex.com/manga/sss-grade-saint-knight/chapter-1/" -o test/fixtures/manhwanex/chapter.html
# Sanity check:
grep -c "wp-manga-chapter" test/fixtures/manhwanex/series.html   # expect > 0
grep -c "reading-content"  test/fixtures/manhwanex/chapter.html  # expect > 0
```

Expected: both `grep -c` print a non-zero number. If `chapter-1` 404s, open `series.html`, find the lowest `chapter-N` link, and capture that instead.

- [ ] **Step 3: Capture qimanhwa fixtures (from the committed probe workflow's artifact)**

The `qimanhwa-probe` workflow (already on `main`) renders real qimanhwa pages and uploads their hydrated DOM. Download that artifact:

```bash
# Find the most recent successful qimanhwa-probe run:
RUN_ID=$(gh run list --workflow=qimanhwa-probe.yml --status=success --limit 1 --json databaseId --jq '.[0].databaseId')
echo "using run $RUN_ID"
gh run download "$RUN_ID" -n qimanhwa-real-dom-capture -D /tmp/qicap
cp /tmp/qicap/series.html  test/fixtures/qimanhwa/series.html
cp /tmp/qicap/chapter.html test/fixtures/qimanhwa/chapter.html
# Sanity check the ng-state blob is present:
grep -c 'id="ng-state"' test/fixtures/qimanhwa/series.html   # expect 1
grep -c 'id="ng-state"' test/fixtures/qimanhwa/chapter.html  # expect 1
```

Expected: both print `1`. If the artifact has expired (>7 days), re-run the workflow first: `gh workflow run qimanhwa-probe.yml --ref main` then wait and re-download.

- [ ] **Step 4: Commit the fixtures**

```bash
git add test/fixtures/manhwanex test/fixtures/qimanhwa
git commit -m "test: add manhwanex + qimanhwa capture fixtures"
```

---

## Task 2: Extend the SourceAdapter id union

**Files:**
- Modify: `src/core/types.ts` (the `SourceAdapter.id` union, ~line 207)
- Test: `test/adapter-registry.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/adapter-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { adapterRegistry } from "../src/adapters/index.js";

describe("adapterRegistry host matching", () => {
  it("routes manhwanex.com to the manhwanex adapter", () => {
    const a = adapterRegistry.matchUrl("https://manhwanex.com/manga/x/");
    expect(a?.id).toBe("manhwanex");
  });

  it("routes qimanhwa.com to the qimanhwa adapter", () => {
    const a = adapterRegistry.matchUrl("https://qimanhwa.com/series/x");
    expect(a?.id).toBe("qimanhwa");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adapter-registry.test.ts`
Expected: FAIL — `matchUrl` returns `null` (adapters not registered yet) / type errors on the new ids.

- [ ] **Step 3: Extend the id union**

In `src/core/types.ts`, change the `SourceAdapter` id line from:

```typescript
  readonly id: "asurascans" | "manhuaplus" | "arenascan" | "drake" | "hivetoons";
```

to:

```typescript
  readonly id:
    | "asurascans"
    | "manhuaplus"
    | "arenascan"
    | "drake"
    | "hivetoons"
    | "manhwanex"
    | "qimanhwa";
```

- [ ] **Step 4: Confirm it still fails for the right reason**

Run: `npx vitest run test/adapter-registry.test.ts`
Expected: still FAIL (adapters not built/registered yet) — but no longer a type error on the ids. Leaves this test red until Tasks 4 and 6 register the adapters. That is intentional; proceed.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts test/adapter-registry.test.ts
git commit -m "feat(types): add manhwanex + qimanhwa to SourceAdapter id union"
```

---

## Task 3: manhwanex parser helpers

**Files:**
- Create: `src/adapters/manhwanex.helpers.ts`
- Test: `test/manhwanex.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/manhwanex.helpers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSeriesMetadata,
  parseChapterList,
  parseReaderImages,
  extractPostId,
  extractChapterNumber,
  ManhwanexParseError,
} from "../src/adapters/manhwanex.helpers.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/manhwanex", name), "utf8");
}
const ORIGIN = "https://manhwanex.com";

describe("parseSeriesMetadata (manhwanex)", () => {
  it("extracts the title from .post-title h1", () => {
    expect(parseSeriesMetadata(fixture("series.html")).title).toBe("SSS Grade Saint Knight");
  });
  it("extracts the cover from .summary_image img", () => {
    expect(parseSeriesMetadata(fixture("series.html")).coverUrl).toBe(
      "https://manhwanex.com/wp-content/uploads/2026/03/SSS-Grade-Saint-Knight-Manhua-Cover.webp",
    );
  });
  it("throws ManhwanexParseError when the title is absent", () => {
    expect(() => parseSeriesMetadata("<html><body></body></html>")).toThrow(ManhwanexParseError);
  });
});

describe("extractPostId (manhwanex)", () => {
  it("reads the Madara post id from the rating/bookmark data-id", () => {
    expect(extractPostId(fixture("series.html"))).toBe("454");
  });
});

describe("parseChapterList (manhwanex)", () => {
  it("returns chapters with absolute urls and numeric numbers", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    expect(chapters.length).toBeGreaterThan(0);
    for (const c of chapters) {
      expect(c.url).toMatch(/^https:\/\/manhwanex\.com\/manga\/sss-grade-saint-knight\/chapter-[\d.]+\/?$/);
      expect(Number.isNaN(c.number)).toBe(false);
    }
  });
  it("returns unique chapter numbers", () => {
    const nums = parseChapterList(fixture("series.html"), ORIGIN).map((c) => c.number);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe("parseReaderImages (manhwanex)", () => {
  it("extracts reader images preferring data-src, in order", () => {
    const imgs = parseReaderImages(fixture("chapter.html"));
    expect(imgs.length).toBeGreaterThan(0);
    for (const u of imgs) expect(u).toMatch(/^https?:\/\//);
  });
  it("does not return whitespace-padded urls", () => {
    for (const u of parseReaderImages(fixture("chapter.html"))) expect(u).toBe(u.trim());
  });
});

describe("extractChapterNumber (manhwanex)", () => {
  it("parses 'Chapter 12'", () => expect(extractChapterNumber("Chapter 12")).toBe(12));
  it("parses decimals", () => expect(extractChapterNumber("Chapter 2.5")).toBe(2.5));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/manhwanex.helpers.test.ts`
Expected: FAIL — module `manhwanex.helpers.js` not found.

- [ ] **Step 3: Implement the helpers**

Create `src/adapters/manhwanex.helpers.ts`:

```typescript
// ---------------------------------------------------------------------------
// manhwanex.helpers.ts — pure parse helpers for manhwanex.com (Madara theme).
//
// Side-effect-free; cheerio only. manhwanex serves a standard Madara/wp-manga
// WordPress theme over LiteSpeed (no Cloudflare):
//   - Series page server-renders the chapter list under .wp-manga-chapter.
//   - Reader page renders pages under .reading-content img (lazy via data-src).
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";

export interface ManhwanexSeries {
  title: string;
  coverUrl: string;
}

export interface RawChapter {
  url: string;
  number: number;
}

export class ManhwanexParseError extends Error {
  override readonly name = "ManhwanexParseError";
}

// Title: .post-title h1 (Madara). Cover: .summary_image img (prefer data-src;
// Madara lazy-loads with data-src and a placeholder in src).
export function parseSeriesMetadata(html: string): ManhwanexSeries {
  const $ = cheerio.load(html);
  const title = $(".post-title h1").first().text().trim();
  if (!title) {
    throw new ManhwanexParseError(
      "parseSeriesMetadata: could not extract title — .post-title h1 not found",
    );
  }
  const $cover = $(".summary_image img").first();
  const coverUrl = ($cover.attr("data-src") ?? $cover.attr("src") ?? "").trim();
  return { title, coverUrl };
}

// Madara exposes the numeric post id on the rating/bookmark widgets as data-id.
export function extractPostId(html: string): string | null {
  const $ = cheerio.load(html);
  const id = $("[data-id]").first().attr("data-id")?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

// Chapter list markup (Madara):
//   <li class="wp-manga-chapter"><a href="https://.../chapter-N/">Chapter N</a>...
// Newest-first in DOM order; caller sorts ascending.
export function parseChapterList(html: string, origin: string): RawChapter[] {
  const $ = cheerio.load(html);
  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  $("li.wp-manga-chapter a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || !/\/chapter-/i.test(href)) return;
    const url = toAbsoluteUrl(href, origin);
    const number = extractChapterNumber($(el).text());
    if (Number.isNaN(number) || seen.has(number)) return;
    seen.add(number);
    chapters.push({ url, number });
  });

  return chapters;
}

// Reader images: .reading-content img, preferring data-src (lazy-load) over src.
export function parseReaderImages(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $(".reading-content img").each((_i, el) => {
    const $img = $(el);
    const u = ($img.attr("data-src") ?? $img.attr("src") ?? "").trim();
    if (u) urls.push(u);
  });
  return urls;
}

export function extractChapterNumber(linkText: string): number {
  const m = /(?:chapter|ch\.?)\s*([\d]+(?:\.[\d]+)?)/i.exec(linkText);
  if (m?.[1]) return parseFloat(m[1]);
  const f = /\b(\d+(?:\.\d+)?)\b/.exec(linkText);
  if (f?.[1]) return parseFloat(f[1]);
  return NaN;
}

function toAbsoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(href, base).toString();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/manhwanex.helpers.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/manhwanex.helpers.ts test/manhwanex.helpers.test.ts
git commit -m "feat(manhwanex): add Madara parser helpers"
```

---

## Task 4: manhwanex adapter + registration

**Files:**
- Create: `src/adapters/manhwanex.ts`
- Modify: `src/adapters/index.ts`
- Test: `test/manhwanex.adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/manhwanex.adapter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manhwanexAdapter } from "../src/adapters/manhwanex.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/manhwanex", name), "utf8");
}
function ctxWith(getBody: string): any {
  return {
    http: { get: vi.fn().mockResolvedValue({ statusCode: 200, body: getBody }) },
    signal: new AbortController().signal,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

describe("ManhwanexAdapter", () => {
  it("matchHost matches manhwanex.com and www.manhwanex.com only", () => {
    expect(manhwanexAdapter.matchHost("manhwanex.com")).toBe(true);
    expect(manhwanexAdapter.matchHost("www.manhwanex.com")).toBe(true);
    expect(manhwanexAdapter.matchHost("example.com")).toBe(false);
  });

  it("id and liveDomain are correct", () => {
    expect(manhwanexAdapter.id).toBe("manhwanex");
    expect(manhwanexAdapter.liveDomain()).toBe("manhwanex.com");
  });

  it("resolveSeries returns title, cover, and pre-enumerated ascending chapters", async () => {
    const ctx = ctxWith(fixture("series.html"));
    const res = await manhwanexAdapter.resolveSeries(ctx, "https://manhwanex.com/manga/sss-grade-saint-knight/");
    expect(res.seriesTitle).toBe("SSS Grade Saint Knight");
    expect(res.coverUrl).toContain("SSS-Grade-Saint-Knight");
    const nums = res.preEnumeratedChapters!.map((c) => c.chapterNumber);
    expect(nums.length).toBeGreaterThan(0);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b)); // ascending
  });

  it("parseChapterImages returns ordered PageStubs with the chapter url as referer", async () => {
    const ctx = ctxWith("");
    const stub = { chapterNumber: 1, chapterTitle: null, chapterUrl: "https://manhwanex.com/manga/sss-grade-saint-knight/chapter-1/" };
    const pages = await manhwanexAdapter.parseChapterImages(ctx, stub, fixture("chapter.html"));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]!.pageIndex).toBe(1);
    expect(pages[0]!.referer).toBe(stub.chapterUrl);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/manhwanex.adapter.test.ts`
Expected: FAIL — module `manhwanex.js` not found.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/manhwanex.ts`:

```typescript
// ---------------------------------------------------------------------------
// manhwanex.ts — SourceAdapter for manhwanex.com (Madara/wp-manga theme).
//
// LiteSpeed, no Cloudflare: everything is fetched with the plain HttpClient.
// resolveSeries reads the server-rendered chapter list; only if that list is
// empty does it fall back to Madara's admin-ajax manga_get_chapters endpoint.
// ---------------------------------------------------------------------------

import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  ResolvedSeries,
  PageStub,
} from "../core/types.js";
import {
  parseSeriesMetadata,
  parseChapterList,
  parseReaderImages,
  extractPostId,
  ManhwanexParseError,
  type RawChapter,
} from "./manhwanex.helpers.js";

const SOURCE_ID = "manhwanex" as const;
const PRIMARY_HOST = "manhwanex.com";
const ORIGIN = "https://manhwanex.com";
const ORIGIN_WITH_SLASH = "https://manhwanex.com/";

class ManhwanexAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  matchHost(host: string): boolean {
    return host.toLowerCase().replace(/^www\./, "") === PRIMARY_HOST;
  }

  domainAliases(): readonly string[] {
    return [];
  }

  liveDomain(): string {
    return PRIMARY_HOST;
  }

  async resolveSeries(
    ctx: AdapterContext,
    seriesUrl: string,
  ): Promise<{
    seriesTitle: string;
    coverUrl: string;
    coverReferer: string;
    postId?: string;
    preEnumeratedChapters?: readonly ChapterStub[];
  }> {
    const resp = await ctx.http.get(seriesUrl, { referer: ORIGIN_WITH_SLASH, signal: ctx.signal });
    const html = resp.body;

    const meta = parseSeriesMetadata(html); // throws ManhwanexParseError if no title
    const postId = extractPostId(html) ?? undefined;

    let rawChapters: RawChapter[] = parseChapterList(html, ORIGIN);

    // Fallback: some Madara series lazy-load the list via admin-ajax.
    if (rawChapters.length === 0 && postId) {
      ctx.logger.warn({ seriesUrl }, "manhwanex: empty static chapter list; trying admin-ajax");
      const ajax = await ctx.http.post(`${ORIGIN}/wp-admin/admin-ajax.php`, {
        form: { action: "manga_get_chapters", manga: postId },
        referer: seriesUrl,
        signal: ctx.signal,
      });
      rawChapters = parseChapterList(ajax.body, ORIGIN);
    }

    rawChapters.sort((a, b) => a.number - b.number);

    const preEnumeratedChapters: ChapterStub[] = rawChapters.map((rc) => ({
      chapterNumber: rc.number,
      chapterTitle: null,
      chapterUrl: rc.url,
    }));

    return {
      seriesTitle: meta.title,
      coverUrl: meta.coverUrl,
      coverReferer: ORIGIN_WITH_SLASH,
      postId,
      preEnumeratedChapters,
    };
  }

  async enumerateChapters(
    ctx: AdapterContext,
    series: ResolvedSeries,
  ): Promise<readonly ChapterStub[]> {
    if (series.preEnumeratedChapters && series.preEnumeratedChapters.length > 0) {
      return series.preEnumeratedChapters;
    }
    const { preEnumeratedChapters } = await this.resolveSeries(ctx, series.seriesId);
    return preEnumeratedChapters ?? [];
  }

  async parseChapterImages(
    _ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const referer = this.imageRefererFor(chapter);
    return parseReaderImages(chapterHtml).map(
      (url, idx): PageStub => ({ pageIndex: idx + 1, imageUrl: url, referer }),
    );
  }

  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // manhwanex has no adult age-gate.
  }
}

export const manhwanexAdapter: SourceAdapter = new ManhwanexAdapter();
export { ManhwanexAdapter };
export { ManhwanexParseError } from "./manhwanex.helpers.js";
```

- [ ] **Step 4: Register the adapter**

In `src/adapters/index.ts`, add the import near the other adapter imports:

```typescript
import { manhwanexAdapter } from "./manhwanex.js";
```

and add `manhwanexAdapter` to the `adapterRegistry` array:

```typescript
export const adapterRegistry: AdapterRegistry = new AdapterRegistryImpl([
  asuraScansAdapter,
  manhuaPlusAdapter,
  arenascanAdapter,
  drakeAdapter,
  hivetoonsAdapter,
  manhwanexAdapter,
]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/manhwanex.adapter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/manhwanex.ts src/adapters/index.ts test/manhwanex.adapter.test.ts
git commit -m "feat(manhwanex): add adapter and register it"
```

---

## Task 5: qimanhwa parser helpers (ng-state + JSON mappers)

**Files:**
- Create: `src/adapters/qimanhwa.helpers.ts`
- Test: `test/qimanhwa.helpers.test.ts`

**Background:** Each qimanhwa page embeds `<script id="ng-state" type="application/json">{...}</script>`. It is **plain JSON** (`JSON.parse` directly — no entity unescaping). It is a map of hash-keys → cached HTTP responses of shape `{ b: <body>, h, s, st, u: <request-url>, rt }`. We locate entries by the `u` (URL) suffix:
- series meta: `u` ends with `/series/<slug>`
- chapter list: `u` ends with `/series/<slug>/chapters`
- single chapter (with images): `u` ends with `/series/<slug>/chapters/<chapter-slug>`

- [ ] **Step 1: Write the failing test**

Create `test/qimanhwa.helpers.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractNgState,
  findCachedBodyByUrlSuffix,
  mapSeriesMeta,
  mapChapterList,
  mapChapterImages,
  QimanhwaParseError,
} from "../src/adapters/qimanhwa.helpers.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/qimanhwa", name), "utf8");
}

describe("extractNgState (qimanhwa)", () => {
  it("parses the ng-state JSON blob", () => {
    const state = extractNgState(fixture("series.html"));
    expect(state).not.toBeNull();
    expect(typeof state).toBe("object");
  });
  it("returns null when no ng-state script is present", () => {
    expect(extractNgState("<html><body>nope</body></html>")).toBeNull();
  });
});

describe("findCachedBodyByUrlSuffix (qimanhwa)", () => {
  it("finds the chapters-list cached body on the series page", () => {
    const state = extractNgState(fixture("series.html"))!;
    const body = findCachedBodyByUrlSuffix(state, "/series/office-worker-who-sees-fate/chapters") as any;
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("mapSeriesMeta (qimanhwa)", () => {
  it("extracts title and cover from the series page ng-state", () => {
    const state = extractNgState(fixture("series.html"))!;
    const meta = mapSeriesMeta(state, "office-worker-who-sees-fate");
    expect(meta.title).toBe("Office Worker Who Sees Fate");
    expect(meta.coverUrl).toMatch(/^https?:\/\//);
  });
});

describe("mapChapterList (qimanhwa)", () => {
  it("maps free chapters to ascending RawQiChapter, skipping paid ones", () => {
    const state = extractNgState(fixture("series.html"))!;
    const { chapters, skippedLocked } = mapChapterList(state, "office-worker-who-sees-fate");
    // Fixture has 30 chapters: 27 free, 3 paid.
    expect(chapters.length).toBe(27);
    expect(skippedLocked).toBe(3);
    const nums = chapters.map((c) => c.number);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));
    for (const c of chapters) {
      expect(c.slug).toMatch(/^chapter-/);
      expect(c.url).toBe(`https://qimanhwa.com/series/office-worker-who-sees-fate/${c.slug}`);
    }
  });
});

describe("mapChapterImages (qimanhwa)", () => {
  it("extracts the chapter image urls in order from the chapter page ng-state", () => {
    const state = extractNgState(fixture("chapter.html"))!;
    const images = mapChapterImages(state, "office-worker-who-sees-fate", "chapter-0");
    expect(images.length).toBe(55);
    for (const u of images) expect(u).toMatch(/^https?:\/\//);
  });
  it("throws QimanhwaParseError when the chapter body is missing", () => {
    const state = extractNgState(fixture("series.html"))!; // series page has no chapter-0 body
    expect(() => mapChapterImages(state, "office-worker-who-sees-fate", "chapter-0")).toThrow(QimanhwaParseError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/qimanhwa.helpers.test.ts`
Expected: FAIL — module `qimanhwa.helpers.js` not found.

- [ ] **Step 3: Implement the helpers**

Create `src/adapters/qimanhwa.helpers.ts`:

```typescript
// ---------------------------------------------------------------------------
// qimanhwa.helpers.ts — pure helpers for qimanhwa.com (Angular SSR SPA).
//
// Each page embeds <script id="ng-state" type="application/json">{...}</script>
// (Angular TransferState) — PLAIN JSON, parse directly. It is a map of
// hash-key -> cached HTTP response { b: body, h, s, st, u: url, rt }. The SSR
// server populates it with the site's REST API responses, so the series meta,
// chapter list, and per-chapter image list are all present without any live
// API call. We locate entries by the request URL (`u`) suffix.
//
// Site origin: https://qimanhwa.com ; API host (in `u` values):
//   https://api.qimanhwa.com/api/v1
// Chapter image urls live on a media CDN (host varies, e.g.
// media.quantumscans.org) and are used verbatim.
// ---------------------------------------------------------------------------

const ORIGIN = "https://qimanhwa.com";

export class QimanhwaParseError extends Error {
  override readonly name = "QimanhwaParseError";
}

export interface QiSeriesMeta {
  title: string;
  coverUrl: string;
}

export interface RawQiChapter {
  slug: string;   // e.g. "chapter-178"
  number: number; // e.g. 178
  url: string;    // https://qimanhwa.com/series/<seriesSlug>/<slug>
}

/** Angular TransferState cache entry. */
interface NgCacheEntry {
  b: unknown; // response body
  u?: string; // request url
}
export type NgStateMap = Record<string, NgCacheEntry>;

// <script id="ng-state" type="application/json"> ... </script> — plain JSON.
const NG_STATE_RE = /<script id="ng-state" type="application\/json">([\s\S]*?)<\/script>/;

export function extractNgState(html: string): NgStateMap | null {
  const m = NG_STATE_RE.exec(html);
  if (!m || !m[1]) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return typeof parsed === "object" && parsed !== null ? (parsed as NgStateMap) : null;
  } catch {
    return null;
  }
}

/** Return the `b` (body) of the cached entry whose request url ends with `suffix`. */
export function findCachedBodyByUrlSuffix(state: NgStateMap, suffix: string): unknown {
  for (const key of Object.keys(state)) {
    const entry = state[key];
    if (entry && typeof entry === "object" && typeof entry.u === "string") {
      const path = entry.u.split("?")[0]!;
      if (path.endsWith(suffix)) return entry.b;
    }
  }
  return undefined;
}

export function mapSeriesMeta(state: NgStateMap, seriesSlug: string): QiSeriesMeta {
  const body = findCachedBodyByUrlSuffix(state, `/series/${seriesSlug}`) as
    | { title?: unknown; cover?: unknown }
    | undefined;
  if (!body || typeof body.title !== "string") {
    throw new QimanhwaParseError(
      `mapSeriesMeta: no series body for "${seriesSlug}" in ng-state`,
    );
  }
  return {
    title: body.title,
    coverUrl: typeof body.cover === "string" ? body.cover : "",
  };
}

interface ChapterListEntry {
  slug: string;
  number: number;
  isFree?: boolean;
  requiresPurchase?: boolean;
}

export function mapChapterList(
  state: NgStateMap,
  seriesSlug: string,
): { chapters: RawQiChapter[]; skippedLocked: number } {
  const body = findCachedBodyByUrlSuffix(state, `/series/${seriesSlug}/chapters`) as
    | { data?: unknown }
    | undefined;
  if (!body || !Array.isArray(body.data)) {
    throw new QimanhwaParseError(
      `mapChapterList: no chapters body for "${seriesSlug}" in ng-state`,
    );
  }

  const chapters: RawQiChapter[] = [];
  let skippedLocked = 0;
  for (const raw of body.data as ChapterListEntry[]) {
    if (typeof raw.slug !== "string" || typeof raw.number !== "number") continue;
    const locked = raw.isFree === false || raw.requiresPurchase === true;
    if (locked) {
      skippedLocked++;
      continue;
    }
    chapters.push({
      slug: raw.slug,
      number: raw.number,
      url: `${ORIGIN}/series/${seriesSlug}/${raw.slug}`,
    });
  }
  chapters.sort((a, b) => a.number - b.number);
  return { chapters, skippedLocked };
}

interface ChapterImage {
  url: string;
  order?: number;
}

export function mapChapterImages(
  state: NgStateMap,
  seriesSlug: string,
  chapterSlug: string,
): string[] {
  const body = findCachedBodyByUrlSuffix(
    state,
    `/series/${seriesSlug}/chapters/${chapterSlug}`,
  ) as { images?: unknown } | undefined;
  if (!body || !Array.isArray(body.images)) {
    throw new QimanhwaParseError(
      `mapChapterImages: no chapter body for "${seriesSlug}/${chapterSlug}" in ng-state`,
    );
  }
  const images = (body.images as ChapterImage[])
    .filter((i) => typeof i.url === "string")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((i) => i.url.trim());
  return images;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/qimanhwa.helpers.test.ts`
Expected: PASS. If `mapChapterList` counts differ, open `test/fixtures/qimanhwa/series.html`, and confirm the chapters-list `data[]` free/paid split; update the `27`/`3` expectations only if the captured fixture genuinely differs.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/qimanhwa.helpers.ts test/qimanhwa.helpers.test.ts
git commit -m "feat(qimanhwa): add ng-state extractor and JSON mappers"
```

---

## Task 6: qimanhwa adapter + registration

**Files:**
- Create: `src/adapters/qimanhwa.ts`
- Modify: `src/adapters/index.ts`
- Test: `test/qimanhwa.adapter.test.ts`

**Approach:** The adapter renders each page through `ctx.browser.renderPage` (headless on CI clears Cloudflare and returns the hydrated HTML with `ng-state`), then parses with the Task 5 helpers. `fetchChapter` renders the chapter URL and returns its HTML as `body`; `parseChapterImages` reads the ng-state from that HTML. This reuses the proven drake-style render path and needs no separate API host / cf_clearance handling.

- [ ] **Step 1: Write the failing test**

Create `test/qimanhwa.adapter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qimanhwaAdapter } from "../src/adapters/qimanhwa.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/qimanhwa", name), "utf8");
}
function ctxRendering(html: string): any {
  return {
    browser: { renderPage: vi.fn().mockResolvedValue(html) },
    signal: new AbortController().signal,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

describe("QimanhwaAdapter", () => {
  it("matchHost matches qimanhwa.com and www. only", () => {
    expect(qimanhwaAdapter.matchHost("qimanhwa.com")).toBe(true);
    expect(qimanhwaAdapter.matchHost("www.qimanhwa.com")).toBe(true);
    expect(qimanhwaAdapter.matchHost("api.qimanhwa.com")).toBe(false);
  });

  it("id and liveDomain are correct", () => {
    expect(qimanhwaAdapter.id).toBe("qimanhwa");
    expect(qimanhwaAdapter.liveDomain()).toBe("qimanhwa.com");
  });

  it("resolveSeries returns title, cover, and ascending free chapters", async () => {
    const ctx = ctxRendering(fixture("series.html"));
    const res = await qimanhwaAdapter.resolveSeries(
      ctx,
      "https://qimanhwa.com/series/office-worker-who-sees-fate",
    );
    expect(res.seriesTitle).toBe("Office Worker Who Sees Fate");
    expect(res.coverUrl).toMatch(/^https?:\/\//);
    const nums = res.preEnumeratedChapters!.map((c) => c.chapterNumber);
    expect(nums.length).toBe(27); // 30 total - 3 paid
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));
  });

  it("fetchChapter renders the chapter url and returns its html", async () => {
    const ctx = ctxRendering(fixture("chapter.html"));
    const stub = { chapterNumber: 0, chapterTitle: null, chapterUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate/chapter-0" };
    const resp = await qimanhwaAdapter.fetchChapter!({ ctx, chapter: stub, seriesUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate", signal: ctx.signal });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain("ng-state");
  });

  it("parseChapterImages returns 55 ordered PageStubs with site-origin referer", async () => {
    const ctx = ctxRendering("");
    const stub = { chapterNumber: 0, chapterTitle: null, chapterUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate/chapter-0" };
    const pages = await qimanhwaAdapter.parseChapterImages(ctx, stub, fixture("chapter.html"));
    expect(pages.length).toBe(55);
    expect(pages[0]!.pageIndex).toBe(1);
    expect(pages[0]!.referer).toBe("https://qimanhwa.com/");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/qimanhwa.adapter.test.ts`
Expected: FAIL — module `qimanhwa.js` not found.

- [ ] **Step 3: Implement the adapter**

Create `src/adapters/qimanhwa.ts`:

```typescript
// ---------------------------------------------------------------------------
// qimanhwa.ts — SourceAdapter for qimanhwa.com (Angular SSR SPA).
//
// qimanhwa is blocked locally by Zscaler ("Online and Other Games") and fronted
// by Cloudflare. It is scraped from a GitHub Actions runner (off-network) where
// the headless BrowserPool clears Cloudflare. Each rendered page embeds an
// Angular TransferState blob (ng-state) carrying the site's REST API responses,
// so series metadata, the chapter list, and per-chapter image lists are all
// parsed from the rendered HTML — no separate API call required.
//
// Paywall: chapters with isFree:false / requiresPurchase:true are skipped.
// ---------------------------------------------------------------------------

import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  ResolvedSeries,
  PageStub,
} from "../core/types.js";
import {
  extractNgState,
  mapSeriesMeta,
  mapChapterList,
  mapChapterImages,
  QimanhwaParseError,
} from "./qimanhwa.helpers.js";

const SOURCE_ID = "qimanhwa" as const;
const PRIMARY_HOST = "qimanhwa.com";
const ORIGIN_WITH_SLASH = "https://qimanhwa.com/";
const RENDER_TIMEOUT_MS = 60_000;

// Pull the series slug out of /series/<slug>[/...].
function seriesSlugFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean); // ["series","<slug>",...]
  if (segs[0] !== "series" || !segs[1]) {
    throw new QimanhwaParseError(`qimanhwa: not a /series/<slug> url: ${url}`);
  }
  return segs[1];
}
function chapterSlugFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean); // ["series","<slug>","<chapterSlug>"]
  if (!segs[2]) throw new QimanhwaParseError(`qimanhwa: no chapter slug in url: ${url}`);
  return segs[2];
}

class QimanhwaAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  matchHost(host: string): boolean {
    return host.toLowerCase().replace(/^www\./, "") === PRIMARY_HOST;
  }

  domainAliases(): readonly string[] {
    return [];
  }

  liveDomain(): string {
    return PRIMARY_HOST;
  }

  async resolveSeries(
    ctx: AdapterContext,
    seriesUrl: string,
  ): Promise<{
    seriesTitle: string;
    coverUrl: string;
    coverReferer: string;
    postId?: string;
    preEnumeratedChapters?: readonly ChapterStub[];
  }> {
    const slug = seriesSlugFromUrl(seriesUrl);
    const html = await ctx.browser.renderPage(seriesUrl, {
      waitForSelector: "script#ng-state",
      state: "attached",
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    const state = extractNgState(html);
    if (!state) {
      throw new QimanhwaParseError(`resolveSeries: no ng-state on ${seriesUrl}`);
    }

    const meta = mapSeriesMeta(state, slug);
    const { chapters, skippedLocked } = mapChapterList(state, slug);
    if (skippedLocked > 0) {
      ctx.logger.warn({ seriesUrl, skippedLocked }, "qimanhwa: skipped locked (paid) chapters");
    }

    const preEnumeratedChapters: ChapterStub[] = chapters.map((c) => ({
      chapterNumber: c.number,
      chapterTitle: null,
      chapterUrl: c.url,
    }));

    return {
      seriesTitle: meta.title,
      coverUrl: meta.coverUrl,
      coverReferer: ORIGIN_WITH_SLASH,
      preEnumeratedChapters,
    };
  }

  async enumerateChapters(
    ctx: AdapterContext,
    series: ResolvedSeries,
  ): Promise<readonly ChapterStub[]> {
    if (series.preEnumeratedChapters && series.preEnumeratedChapters.length > 0) {
      return series.preEnumeratedChapters;
    }
    const { preEnumeratedChapters } = await this.resolveSeries(ctx, series.seriesId);
    return preEnumeratedChapters ?? [];
  }

  // Render the chapter page through the (CF-clearing) browser and return its HTML.
  async fetchChapter(args: {
    ctx: AdapterContext;
    chapter: ChapterStub;
    seriesUrl: string;
    signal: AbortSignal;
  }): Promise<{ statusCode: number; body: string }> {
    const { ctx, chapter } = args;
    const body = await ctx.browser.renderPage(chapter.chapterUrl, {
      waitForSelector: "script#ng-state",
      state: "attached",
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    return { statusCode: 200, body };
  }

  async parseChapterImages(
    _ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const state = extractNgState(chapterHtml);
    if (!state) {
      throw new QimanhwaParseError(`parseChapterImages: no ng-state for ${chapter.chapterUrl}`);
    }
    const slug = seriesSlugFromUrl(chapter.chapterUrl);
    const chapterSlug = chapterSlugFromUrl(chapter.chapterUrl);
    const referer = this.imageRefererFor(chapter);
    return mapChapterImages(state, slug, chapterSlug).map(
      (url, idx): PageStub => ({ pageIndex: idx + 1, imageUrl: url, referer }),
    );
  }

  imageRefererFor(_chapter: ChapterStub): string {
    return ORIGIN_WITH_SLASH;
  }

  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // No adult age-gate.
  }
}

export const qimanhwaAdapter: SourceAdapter = new QimanhwaAdapter();
export { QimanhwaAdapter };
export { QimanhwaParseError } from "./qimanhwa.helpers.js";
```

- [ ] **Step 4: Register the adapter**

In `src/adapters/index.ts`, add the import:

```typescript
import { qimanhwaAdapter } from "./qimanhwa.js";
```

and add `qimanhwaAdapter` to the `adapterRegistry` array (after `manhwanexAdapter`):

```typescript
export const adapterRegistry: AdapterRegistry = new AdapterRegistryImpl([
  asuraScansAdapter,
  manhuaPlusAdapter,
  arenascanAdapter,
  drakeAdapter,
  hivetoonsAdapter,
  manhwanexAdapter,
  qimanhwaAdapter,
]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/qimanhwa.adapter.test.ts test/adapter-registry.test.ts`
Expected: PASS (this also turns the Task 2 registry test green).

- [ ] **Step 6: Run the whole suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (the original 207 plus the new ones).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/qimanhwa.ts src/adapters/index.ts test/qimanhwa.adapter.test.ts
git commit -m "feat(qimanhwa): add adapter (ng-state via headless render) and register it"
```

---

## Task 7: Authenticator (TOTP) gate — validator script + secret setup

**Why:** The repo is public. `workflow_dispatch` already restricts triggering to
collaborators with **write** access + a valid token (the public can read code but
cannot run Actions). We add a **TOTP second factor**, validated **server-side as
the first workflow step**, so that even a leaked token cannot launch a scrape
without the rotating 6-digit code from an authenticator app. The TOTP secret is
stored as an **environment** secret restricted to `main` (Step 5), and the
workflow file is protected by branch protection + CODEOWNERS (Task 10) — together
these stop the "push a modified workflow on a feature branch and dispatch it"
bypass, because the secret is unavailable to runs off `main` and the gate can't be
edited without a code-owner-reviewed PR.

**Files:**
- Create: `scripts/totp.mjs` (RFC 6238 TOTP, no external deps — Node `crypto`)
- Test: `test/totp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/totp.test.ts`:

```typescript
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
    // 287082 is valid for the window containing T=59s; still accepted 25s later.
    expect(verifyTotp(SECRET, "287082", 84_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/totp.test.ts`
Expected: FAIL — `scripts/totp.mjs` not found.

- [ ] **Step 3: Implement the validator**

Create `scripts/totp.mjs`:

```javascript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/totp.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Generate the secret and register it (one-time)**

```bash
node scripts/totp.mjs gen
```

This prints a `secret:` line and an `otpauth://` URI. Do two things with it:
1. Add it to your authenticator app (Google Authenticator / Authy): either paste the
   `secret` as a manual "time-based" key, or turn the `otpauth://` URI into a QR
   (any offline QR generator) and scan it.
2. Store the secret as a GitHub **environment** secret scoped to the `production`
   environment (created/locked to `main` in Task 10), so workflow runs off `main`
   cannot read it (requires repo admin):

```bash
# Create the environment if it does not exist yet (idempotent):
gh api -X PUT repos/vajohn/verreaux-scraper/environments/production >/dev/null
# Store the TOTP secret in that environment (NOT as a repo-wide secret):
gh secret set SCRAPE_TOTP_SECRET --env production --body "<paste-the-secret-from-step-above>"
```

Verify the app and the secret agree: `SCRAPE_TOTP_SECRET="<secret>" node scripts/totp.mjs now` should print the same 6 digits your app shows.

- [ ] **Step 6: Commit (the secret value is NOT committed — only the validator code)**

```bash
git add scripts/totp.mjs test/totp.test.ts
git commit -m "feat(ci): add RFC 6238 TOTP validator for the scrape gate"
```

---

## Task 8: GitHub-Actions scrape workflow (TOTP-gated) + README

**Files:**
- Create: `.github/workflows/scrape.yml`
- Modify: `README.md`

The CLI (`verreaux-scrape`, i.e. `dist/cli/index.js`) takes the series URL as a
**positional argument** plus `--from`/`--to` (or `--chapters`) and `--out`
(default `./dist`, overridden to `./output` to avoid the build dir). On CI we do
NOT pass `--allow-headed-cloudflare` — the default headless browser clears
Cloudflare. The `otp` input is validated **first**, before any build or scrape.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/scrape.yml`:

```yaml
name: scrape

# Run the scraper from a GitHub runner (off the Zscaler corporate network).
# Required for qimanhwa.com (Zscaler-blocked locally); also works for manhwanex.
# Gated by a TOTP authenticator code validated server-side as the FIRST step.
# Trigger via the local wrapper (scripts/scrape-remote.mjs) or the Actions tab.

on:
  workflow_dispatch:
    inputs:
      url:
        description: "Series URL, e.g. https://qimanhwa.com/series/<slug>"
        required: true
        type: string
      args:
        description: "Chapter selection + flags, e.g. '--from 1 --to 10' or '--chapters 5,12'"
        required: true
        default: "--from 0 --to latest"
        type: string
      otp:
        description: "6-digit authenticator code"
        required: true
        type: string

permissions:
  contents: read

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    # Binds the job to the `production` environment so SCRAPE_TOTP_SECRET (an
    # environment secret locked to `main`, see Task 10) is only available here.
    environment: production
    steps:
      - uses: actions/checkout@v4
      - name: Validate authenticator code (gate)
        env:
          SCRAPE_TOTP_SECRET: ${{ secrets.SCRAPE_TOTP_SECRET }}
          OTP: ${{ inputs.otp }}
        run: |
          if [ -z "$SCRAPE_TOTP_SECRET" ]; then echo "::error::SCRAPE_TOTP_SECRET not configured"; exit 1; fi
          node scripts/totp.mjs verify "$OTP" || { echo "::error::Invalid authenticator code"; exit 1; }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - name: Run scraper (headless)
        env:
          CI: "true"
          SERIES_URL: ${{ inputs.url }}
          EXTRA_ARGS: ${{ inputs.args }}
        run: |
          # EXTRA_ARGS is intentionally unquoted so multiple flags word-split.
          node dist/cli/index.js "$SERIES_URL" $EXTRA_ARGS --out ./output --log-format json --no-color
      - name: Upload output ZIPs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: scrape-output
          path: output/**/*.zip
          if-no-files-found: warn
          retention-days: 7
```

- [ ] **Step 2: Validate the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/scrape.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: Update the README**

In `README.md`, add two rows to the "Supported sources" table (match the existing column format):

```
| manhwanex.com | manhwanex | ✅ Working |
| qimanhwa.com  | qimanhwa  | ✅ via GitHub Actions (Zscaler-blocked locally) |
```

And append to the "Corporate networks (Zscaler / MITM proxies)" section:

```markdown
**qimanhwa.com** is blocked by Katim's Zscaler under the "Online and Other Games"
category and cannot be scraped from the corporate network. Scrape it via the
TOTP-gated GitHub Actions workflow using the local wrapper:

    node scripts/scrape-remote.mjs https://qimanhwa.com/series/<slug> -- --from 1 --to 10

You'll be prompted for your authenticator code; the wrapper dispatches the remote
run, waits, and downloads the resulting ZIP(s) into ./output — so it feels like a
local download even though the work runs on GitHub. Output ZIPs are also kept as a
build artifact for 7 days.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/scrape.yml README.md
git commit -m "ci: add TOTP-gated GitHub-Actions scrape workflow; document qimanhwa egress"
```

---

## Task 9: Local wrapper — feels-local, runs-remote

**Goal:** one local command that prompts for the authenticator code, dispatches the
gated workflow, waits for it, and downloads + extracts the ZIP into `./output`.

**Files:**
- Create: `scripts/scrape-remote.mjs`

- [ ] **Step 1: Implement the wrapper**

Create `scripts/scrape-remote.mjs`:

```javascript
#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scrape-remote.mjs — local wrapper around the TOTP-gated `scrape` workflow.
//
// Scrapes a source that is unreachable locally (e.g. qimanhwa, blocked by
// Zscaler) by running it on GitHub Actions, then downloads the result to
// ./output. From the user's side it looks like a local download.
//
// Requires the GitHub CLI (`gh`) authenticated with write access to the repo.
//
// Usage:
//   node scripts/scrape-remote.mjs <series-url> [-- <extra cli args>]
//   e.g. node scripts/scrape-remote.mjs https://qimanhwa.com/series/x -- --from 1 --to 10
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts }).trim();
}

// Read a 6-digit code without echoing it to the terminal.
function promptCode(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let val = "";
    const done = () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(val.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (code === 10 || code === 13 || code === 4) return done(); // Enter / EOT
        if (code === 3) { process.stdout.write("\n"); process.exit(1); } // Ctrl-C
        if (code === 127 || code === 8) { val = val.slice(0, -1); continue; } // backspace
        val += ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const url = process.argv[2];
if (!url || url.startsWith("-")) {
  console.error("usage: scrape-remote.mjs <series-url> [-- <extra cli args>]");
  process.exit(2);
}
const sepIdx = process.argv.indexOf("--");
const extraArgs = sepIdx === -1 ? "--from 0 --to latest" : process.argv.slice(sepIdx + 1).join(" ");

const code = await promptCode("Authenticator code: ");
if (!/^\d{6}$/.test(code)) {
  console.error("Expected a 6-digit code.");
  process.exit(2);
}

console.log("Connecting…");
gh([
  "workflow", "run", "scrape.yml", "--ref", "main",
  "-f", `url=${url}`, "-f", `args=${extraArgs}`, "-f", `otp=${code}`,
]);

// The dispatched run takes a moment to register; grab the newest run id.
await new Promise((r) => setTimeout(r, 6000));
const runId = gh([
  "run", "list", "--workflow=scrape.yml", "--event=workflow_dispatch",
  "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
]);
if (!runId) { console.error("Could not locate the dispatched run."); process.exit(1); }

// Stream progress; non-zero exit means the OTP gate or the scrape failed.
console.log("Downloading… (this runs remotely; please wait)");
const watch = spawnSync("gh", ["run", "watch", runId, "--exit-status", "--interval", "15"], {
  stdio: "inherit",
});
if (watch.status !== 0) {
  console.error("Failed — invalid code or scrape error. See the run output above.");
  process.exit(1);
}

gh(["run", "download", runId, "-n", "scrape-output", "-D", "./output"]);
console.log("\nDone. Saved to ./output/");
```

- [ ] **Step 2: Smoke-check the arg parsing (no network)**

Run: `node scripts/scrape-remote.mjs` (with no args)
Expected: prints the usage line and exits non-zero.

Run: `printf '123\n' | node scripts/scrape-remote.mjs https://qimanhwa.com/series/x -- --from 1 --to 1`
Expected: it reads the code, then rejects it with "Expected a 6-digit code." (123 is too short) and exits — confirming the prompt + validation path without dispatching. (A correct 6-digit code would proceed to call `gh`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/scrape-remote.mjs
git commit -m "feat(ci): add local wrapper to run + download TOTP-gated remote scrapes"
```

---

## Task 10: Repo hardening — branch protection + CODEOWNERS

**Why:** Makes the TOTP gate tamper-resistant on a public repo. Three controls,
each closing a specific hole:
1. **CODEOWNERS** — changes to the gate (`.github/workflows/`, `scripts/totp.mjs`)
   require the owner's review.
2. **Branch protection on `main`** — no direct pushes/force-pushes; changes land
   only via code-owner-reviewed PRs with the test check green. Protects the
   workflow + validator from being edited around.
3. **Environment branch policy** — `SCRAPE_TOTP_SECRET` lives in the `production`
   environment locked to `main`, so a workflow pushed on a feature branch and
   dispatched cannot read the secret (nor exfiltrate it), and the gate it would
   skip has nothing to skip to.

**Files:**
- Create: `.github/CODEOWNERS`

> Note: branch protection and environment policies are configured on GitHub via
> `gh api`, not in the repo. These commands require repo **admin**. Replace the
> owner handle if the repo moves. They are idempotent enough to re-run.

- [ ] **Step 1: Add CODEOWNERS**

Create `.github/CODEOWNERS`:

```
# Security-sensitive paths require the repo owner's review.
/.github/        @vajohn
/scripts/totp.mjs @vajohn
```

Commit it:

```bash
git add .github/CODEOWNERS
git commit -m "chore: add CODEOWNERS for the scrape gate"
```

- [ ] **Step 2: Lock the `production` environment to `main`**

This ensures the environment secret is only available to runs on `main`:

```bash
gh api -X PUT repos/vajohn/verreaux-scraper/environments/production \
  -F "deployment_branch_policy[protected_branches]=false" \
  -F "deployment_branch_policy[custom_branch_policies]=true" >/dev/null
gh api -X POST repos/vajohn/verreaux-scraper/environments/production/deployment-branch-policies \
  -f name=main >/dev/null
```

Expected: no error. Verify only `main` is allowed:

```bash
gh api repos/vajohn/verreaux-scraper/environments/production/deployment-branch-policies --jq '.branch_policies[].name'
```
Expected output: `main`.

- [ ] **Step 3: Enable branch protection on `main`**

```bash
gh api -X PUT repos/vajohn/verreaux-scraper/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Expected: a JSON object describing the protection (HTTP 200). Notes:
- `"contexts": []` means "require checks to be up to date" without pinning a
  specific check name yet; after the first CI run you can add the test job's check
  name to make a green test suite mandatory before merge.
- `enforce_admins: true` means even the owner merges via PR. If that is too strict
  for a solo maintainer, set it to `false` — but then an admin token can bypass the
  gate, so prefer `true`.

- [ ] **Step 4: Verify protection is active**

```bash
gh api repos/vajohn/verreaux-scraper/branches/main/protection --jq '{admins: .enforce_admins.enabled, codeowners: .required_pull_request_reviews.require_code_owner_reviews, force: .allow_force_pushes.enabled}'
```
Expected: `{"admins":true,"codeowners":true,"force":false}`.

> Consequence for this plan: once `main` is protected, the feature branch
> `feat/manhwanex-qimanhwa-adapters` must be merged via a PR (Task 11 Step 3),
> not pushed straight to `main`.

---

## Task 11: Final verification

- [ ] **Step 1: Full gate**

Run: `npm run lint && npm run typecheck && npm test`
Expected: lint clean, typecheck clean, all tests pass (includes the new TOTP test).

- [ ] **Step 2: Build succeeds**

Run: `npm run build`
Expected: builds without error.

- [ ] **Step 3: Push the branch and open a PR (main is protected)**

Since Task 10 protects `main`, merge via a code-owner-reviewed PR rather than
pushing to `main` directly:

```bash
git push -u origin feat/manhwanex-qimanhwa-adapters
gh pr create --base main --head feat/manhwanex-qimanhwa-adapters \
  --title "feat: manhwanex + qimanhwa adapters, TOTP-gated remote scrape" \
  --body "Implements docs/superpowers/plans/2026-06-08-manhwanex-qimanhwa-adapters.md"
# After review + green checks:
gh pr merge --squash --delete-branch
```

- [ ] **Step 4 (live, end-to-end): qimanhwa via the wrapper**

After the PR is merged to `main` (the workflow must exist on `main` to be
dispatchable, and the `production` environment secret is only readable there) and
`SCRAPE_TOTP_SECRET` is set (Task 7 Step 5):

```bash
node scripts/scrape-remote.mjs https://qimanhwa.com/series/office-worker-who-sees-fate -- --from 1 --to 2
```

Enter your authenticator code when prompted. Expected: the run completes and a
non-empty ZIP appears under `./output/`. This is the real end-to-end proof.

---

## Notes / risks for the implementer

- **qimanhwa is unreachable locally** — its adapter cannot be exercised against the live site from the corporate network. All its tests are fixture-based; live validation happens only via the `scrape` / `qimanhwa-probe` workflows on GitHub Actions.
- **`cf_clearance` carries the session:** the volume probe showed sequential chapter renders stay `200` with no re-challenge, so `renderPage`'s per-host context reuse is sufficient; no extra throttling beyond the existing `Throttler` is required, but keep pacing comparable to the probe (~6 s/page).
- **Image host varies** (`media.quantumscans.org`, `media.qimanhwa.com`). The adapter uses `images[].url` verbatim; if the default image client is ever rejected by the CDN, add an optional `fetchImage` that routes through `ctx.browser.fetchBuffer` (see drake's `fetchImage`).
- **manhwanex admin-ajax fallback** is only hit if a series renders an empty static chapter list. The captured fixture has a populated list, so that path is not fixture-tested; it mirrors the documented Madara `manga_get_chapters` action.
