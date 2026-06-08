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
- `.github/workflows/scrape.yml` — run the scraper CLI on a GitHub runner.

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

## Task 7: GitHub-Actions scrape workflow + README

**Files:**
- Create: `.github/workflows/scrape.yml`
- Modify: `README.md`

- [ ] **Step 1: Create the workflow**

The CLI (`verreaux-scrape`, i.e. `dist/cli/index.js`) takes the series URL as a
**positional argument** plus `--from`/`--to` (or `--chapters`) and `--out`
(default `./dist`, which we override to `./output` to avoid the build dir).
On CI we do NOT pass `--allow-headed-cloudflare` — the default headless browser
clears Cloudflare (proven by the probe). The free-form `args` input carries the
chapter selection so the full CLI surface stays available.

Create `.github/workflows/scrape.yml`:

```yaml
name: scrape

# Run the scraper from a GitHub runner (off the Zscaler corporate network).
# Required for qimanhwa.com (Zscaler-blocked locally); also works for manhwanex.
# Trigger: Actions tab -> scrape -> Run workflow.

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

permissions:
  contents: read

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
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
          # This workflow is manual (workflow_dispatch) and owner-triggered only.
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
category and cannot be scraped from the corporate network. Run it from GitHub
Actions instead: Actions tab → **scrape** → Run workflow, with the series URL and
chapter range. A headless browser clears Cloudflare automatically; output ZIPs are
uploaded as a build artifact.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/scrape.yml README.md
git commit -m "ci: add GitHub-Actions scrape workflow; document qimanhwa egress"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full gate**

Run: `npm run lint && npm run typecheck && npm test`
Expected: lint clean, typecheck clean, all tests pass.

- [ ] **Step 2: Build succeeds**

Run: `npm run build`
Expected: builds without error (confirms the new adapters compile under the build tsconfig).

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feat/manhwanex-qimanhwa-adapters
```

- [ ] **Step 4 (optional, live): Smoke-test qimanhwa on GitHub Actions**

After the branch is pushed, run the `scrape` workflow against
`https://qimanhwa.com/series/office-worker-who-sees-fate` with `chapters=1-2` and
confirm the output artifact contains a non-empty ZIP. (This is the real end-to-end
proof; do it before merging if you want certainty.)

---

## Notes / risks for the implementer

- **qimanhwa is unreachable locally** — its adapter cannot be exercised against the live site from the corporate network. All its tests are fixture-based; live validation happens only via the `scrape` / `qimanhwa-probe` workflows on GitHub Actions.
- **`cf_clearance` carries the session:** the volume probe showed sequential chapter renders stay `200` with no re-challenge, so `renderPage`'s per-host context reuse is sufficient; no extra throttling beyond the existing `Throttler` is required, but keep pacing comparable to the probe (~6 s/page).
- **Image host varies** (`media.quantumscans.org`, `media.qimanhwa.com`). The adapter uses `images[].url` verbatim; if the default image client is ever rejected by the CDN, add an optional `fetchImage` that routes through `ctx.browser.fetchBuffer` (see drake's `fetchImage`).
- **manhwanex admin-ajax fallback** is only hit if a series renders an empty static chapter list. The captured fixture has a populated list, so that path is not fixture-tested; it mirrors the documented Madara `manga_get_chapters` action.
