// ---------------------------------------------------------------------------
// asurascans.adapter.test.ts — integration tests for AsuraScansAdapter
// using mocked ctx.http and live-captured Astro v5 fixtures.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AsuraScansAdapter, SlugMutationUnrecoverableError } from "../src/adapters/asurascans.js";
import type { AdapterContext, ChapterStub } from "../src/core/types.js";
import type { EventBus } from "../src/core/events.js";

const FIXTURES = join(import.meta.dirname ?? __dirname, "fixtures", "asurascans-astro");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeMockCtx(overrides: {
  httpGetResponses?: Array<{ statusCode: number; body: string }>;
  httpGetFn?: (url: string) => { statusCode: number; body: string };
  cookieSetFn?: ReturnType<typeof vi.fn>;
  eventBusEmitFn?: ReturnType<typeof vi.fn>;
  browserRenderPageFn?: ReturnType<typeof vi.fn>;
}): AdapterContext & { eventBus: { emit: ReturnType<typeof vi.fn> } } {
  const callQueue = overrides.httpGetResponses ? [...overrides.httpGetResponses] : [];

  const cookieSetFn = overrides.cookieSetFn ?? vi.fn();
  const eventBusEmitFn = overrides.eventBusEmitFn ?? vi.fn();
  const browserRenderPageFn =
    overrides.browserRenderPageFn ?? vi.fn().mockResolvedValue("<html></html>");

  const httpGetFn =
    overrides.httpGetFn ??
    ((_url: string) => {
      const next = callQueue.shift();
      if (!next) throw new Error("httpGet mock: unexpected call — no more responses in queue");
      return next;
    });

  const httpMock = {
    get: vi.fn().mockImplementation((url: string) => Promise.resolve(httpGetFn(url))),
    isCloudflareChallenged: vi.fn().mockReturnValue(false),
  };

  const ctx = {
    http: httpMock as unknown as AdapterContext["http"],
    browser: {
      renderPage: browserRenderPageFn,
    } as unknown as AdapterContext["browser"],
    cookies: {
      set: cookieSetFn,
    } as unknown as AdapterContext["cookies"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as AdapterContext["logger"],
    throttle: {} as unknown as AdapterContext["throttle"],
    signal: new AbortController().signal,
    eventBus: { emit: eventBusEmitFn } as unknown as EventBus,
  };

  return ctx as unknown as AdapterContext & { eventBus: { emit: ReturnType<typeof vi.fn> } };
}

function makeChapterStub(overrides: Partial<ChapterStub> = {}): ChapterStub {
  return {
    chapterNumber: 1,
    chapterTitle: null,
    chapterUrl:
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveSeries — against Astro fixture
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter.resolveSeries", () => {
  let adapter: AsuraScansAdapter;

  beforeEach(() => {
    adapter = new AsuraScansAdapter();
  });

  it("resolves series from Astro fixture HTML — returns title, cover, and 84 chapters", async () => {
    const seriesHtml = fixture("series.html");
    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        if (!url.includes("/comics/")) {
          // liveDomain probe
          return { statusCode: 200, body: "<html><body>homepage</body></html>" };
        }
        return { statusCode: 200, body: seriesHtml };
      },
    });

    const result = await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    expect(result.seriesTitle).toBe("The Max-Level Player's 100th Regression");
    expect(result.coverUrl).toContain("cdn.asurascans.com");
    expect(result.preEnumeratedChapters).toBeDefined();
    expect(result.preEnumeratedChapters!.length).toBe(84);
  });

  it("chapters are sorted ascending by number", async () => {
    const seriesHtml = fixture("series.html");
    const ctx = makeMockCtx({
      httpGetFn: (_url: string) => ({ statusCode: 200, body: seriesHtml }),
    });

    const result = await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    const nums = result.preEnumeratedChapters!.map((c) => c.chapterNumber);
    // First chapter should be 0, last should be 83.
    expect(nums[0]).toBe(0);
    expect(nums[nums.length - 1]).toBe(83);
    // Sorted check
    for (let i = 0; i < nums.length - 1; i++) {
      expect(nums[i]).toBeLessThan(nums[i + 1]!);
    }
  });

  it("emits adapter.series.resolved event", async () => {
    const seriesHtml = fixture("series.html");
    const emitFn = vi.fn();
    const ctx = makeMockCtx({
      httpGetFn: (_url: string) => ({ statusCode: 200, body: seriesHtml }),
      eventBusEmitFn: emitFn,
    });

    await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    const calls = emitFn.mock.calls.map((c) => c[0]);
    expect(calls).toContain("adapter.series.resolved");
  });

  it("chapter URLs use /comics/ path and contain the live domain", async () => {
    const seriesHtml = fixture("series.html");
    const ctx = makeMockCtx({
      httpGetFn: (_url: string) => ({ statusCode: 200, body: seriesHtml }),
    });

    const result = await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    for (const ch of result.preEnumeratedChapters!) {
      expect(ch.chapterUrl).toContain("asurascans.com");
      expect(ch.chapterUrl).toContain("/comics/");
      expect(ch.chapterUrl).toContain("/chapter/");
    }
  });

  it("chapter URLs do NOT use /series/ path", async () => {
    const seriesHtml = fixture("series.html");
    const ctx = makeMockCtx({
      httpGetFn: (_url: string) => ({ statusCode: 200, body: seriesHtml }),
    });

    const result = await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    for (const ch of result.preEnumeratedChapters!) {
      expect(ch.chapterUrl).not.toContain("/series/");
    }
  });

  it("chapters are sorted ascending from inline Astro HTML", async () => {
    // A synthetic page with chapters in reverse order to test sort.
    const syntheticHtml = `
      <html>
        <head>
          <meta property="og:image" content="https://cdn.asurascans.com/asura-images/covers/test.abc123.webp">
        </head>
        <body>
          <h1>Test Series</h1>
          <a href="/comics/test-series-abcdef/chapter/10">Chapter 10</a>
          <a href="/comics/test-series-abcdef/chapter/3">Chapter 3</a>
          <a href="/comics/test-series-abcdef/chapter/1">Chapter 1</a>
        </body>
      </html>
    `;
    const ctx = makeMockCtx({
      httpGetFn: (_url: string) => ({ statusCode: 200, body: syntheticHtml }),
    });

    const result = await adapter.resolveSeries(
      ctx,
      "https://asurascans.com/comics/test-series-abcdef",
    );

    const nums = result.preEnumeratedChapters!.map((c) => c.chapterNumber);
    expect(nums).toEqual([1, 3, 10]);
  });
});

// ---------------------------------------------------------------------------
// parseChapterImages — against Astro chapter fixture
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter.parseChapterImages", () => {
  let adapter: AsuraScansAdapter;

  beforeEach(() => {
    adapter = new AsuraScansAdapter();
  });

  it("returns 24 PageStubs from the Astro chapter fixture", async () => {
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub({
      chapterNumber: 0,
      chapterUrl:
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/0",
    });
    const ctx = makeMockCtx({});

    const stubs = await adapter.parseChapterImages(ctx, chapter, chapterHtml);

    expect(stubs.length).toBe(24);
  });

  it("PageStubs are numbered 1..N", async () => {
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub({ chapterNumber: 0 });
    const ctx = makeMockCtx({});

    const stubs = await adapter.parseChapterImages(ctx, chapter, chapterHtml);

    for (let i = 0; i < stubs.length; i++) {
      expect(stubs[i]!.pageIndex).toBe(i + 1);
    }
  });

  it("every imageUrl starts with https://cdn.asurascans.com/", async () => {
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub({ chapterNumber: 0 });
    const ctx = makeMockCtx({});

    const stubs = await adapter.parseChapterImages(ctx, chapter, chapterHtml);

    for (const stub of stubs) {
      expect(stub.imageUrl).toMatch(/^https:\/\/cdn\.asurascans\.com\//);
    }
  });

  it("referer on each stub equals the chapter URL", async () => {
    const chapterHtml = fixture("chapter.html");
    const chapterUrl =
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/0";
    const chapter = makeChapterStub({ chapterNumber: 0, chapterUrl });
    const ctx = makeMockCtx({});

    const stubs = await adapter.parseChapterImages(ctx, chapter, chapterHtml);

    for (const stub of stubs) {
      expect(stub.referer).toBe(chapterUrl);
    }
  });

  it("falls through to renderPage when HTML has no CDN images (returns empty)", async () => {
    const emptyHtml = "<html><body><p>no images</p></body></html>";
    const chapter = makeChapterStub();
    const browserHtml = fixture("chapter.html");
    const ctx = makeMockCtx({
      browserRenderPageFn: vi.fn().mockResolvedValue(browserHtml),
    });

    const stubs = await adapter.parseChapterImages(ctx, chapter, emptyHtml);

    // After Playwright fallback, we should have images.
    expect(stubs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// fetchAndParseChapter — full pipeline
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter.fetchAndParseChapter", () => {
  let adapter: AsuraScansAdapter;

  beforeEach(() => {
    adapter = new AsuraScansAdapter();
  });

  it("returns PageStubs from a normal chapter page", async () => {
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub({
      chapterNumber: 0,
      chapterUrl:
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/0",
    });

    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        if (!url.includes("/chapter/")) {
          return { statusCode: 200, body: "<html><body>home</body></html>" };
        }
        return { statusCode: 200, body: chapterHtml };
      },
    });

    const stubs = await adapter.fetchAndParseChapter(
      ctx,
      chapter,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    expect(stubs.length).toBe(24);
    expect(stubs[0]!.pageIndex).toBe(1);
    expect(stubs[23]!.pageIndex).toBe(24);
    expect(stubs[0]!.imageUrl).toContain("cdn.asurascans.com");
  });

  it("auto-dismisses NSFW splash and retries — never throws on splash", async () => {
    const splashHtml =
      "<html><body><p>Mature content — 18+ only. Click to continue.</p></body></html>";
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub();
    const setFn = vi.fn();

    let callCount = 0;
    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        if (!url.includes("/chapter/")) {
          return { statusCode: 200, body: "<html>home</html>" };
        }
        callCount++;
        return callCount === 1
          ? { statusCode: 200, body: splashHtml }
          : { statusCode: 200, body: chapterHtml };
      },
      cookieSetFn: setFn,
    });

    const stubs = await adapter.fetchAndParseChapter(
      ctx,
      chapter,
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );

    expect(stubs.length).toBeGreaterThan(0);
    expect(setFn.mock.calls.length).toBeGreaterThan(0);
  });

  it("404 → emits adapter.slug.mutation_detected", async () => {
    const seriesHtml = fixture("series.html");
    const chapterHtml = fixture("chapter.html");
    const chapter = makeChapterStub({
      chapterUrl:
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/1",
    });
    const emitFn = vi.fn();

    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        if (!url.includes("/comics/") && !url.includes("/chapter/")) {
          return { statusCode: 200, body: "<html>home</html>" };
        }
        if (url.includes("/chapter/")) {
          if (url.includes("030ff47a")) {
            return { statusCode: 404, body: "Not found" };
          }
          return { statusCode: 200, body: chapterHtml };
        }
        return { statusCode: 200, body: seriesHtml };
      },
      eventBusEmitFn: emitFn,
    });

    await expect(
      adapter.fetchAndParseChapter(
        ctx,
        chapter,
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
      ),
    ).rejects.toThrow();

    const emittedTypes = emitFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(emittedTypes).toContain("adapter.slug.mutation_detected");
  });

  it("404 twice → emits adapter.slug.mutation_unrecoverable and throws SlugMutationUnrecoverableError", async () => {
    const seriesHtml = fixture("series.html");
    const chapter = makeChapterStub({
      chapterUrl:
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/1",
    });
    const emitFn = vi.fn();

    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        if (!url.includes("/comics/") && !url.includes("/chapter/")) {
          return { statusCode: 200, body: "<html>home</html>" };
        }
        if (url.includes("/chapter/")) {
          return { statusCode: 404, body: "Not found" };
        }
        return { statusCode: 200, body: seriesHtml };
      },
      eventBusEmitFn: emitFn,
    });

    await expect(
      adapter.fetchAndParseChapter(
        ctx,
        chapter,
        "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
      ),
    ).rejects.toThrow(SlugMutationUnrecoverableError);

    const emittedTypes = emitFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(emittedTypes).toContain("adapter.slug.mutation_unrecoverable");
  });
});

// ---------------------------------------------------------------------------
// imageRefererFor
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter.imageRefererFor", () => {
  const adapter = new AsuraScansAdapter();

  it("returns the chapter URL as-is", () => {
    const url =
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/42";
    expect(adapter.imageRefererFor({ chapterNumber: 42, chapterTitle: null, chapterUrl: url })).toBe(url);
  });

  it("returns URL including query string unchanged", () => {
    const url =
      "https://asurascans.com/comics/test-abc123/chapter/1?style=list&page=1";
    expect(adapter.imageRefererFor({ chapterNumber: 1, chapterTitle: null, chapterUrl: url })).toBe(url);
  });

  it("does not modify URL in any way", () => {
    const url =
      "https://asurascans.com/comics/my-series-deadbeef/chapter/99.5";
    const result = adapter.imageRefererFor({ chapterNumber: 99.5, chapterTitle: null, chapterUrl: url });
    expect(result).toBe(url);
    expect(result).toStrictEqual(url);
  });
});

// ---------------------------------------------------------------------------
// dismissNsfwSplash — cookie setting behaviour
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter.dismissNsfwSplash", () => {
  let adapter: AsuraScansAdapter;

  beforeEach(() => {
    adapter = new AsuraScansAdapter();
  });

  it("sets bypass cookies via dismissNsfwSplash — idempotent", async () => {
    const setFn = vi.fn();
    const ctx = makeMockCtx({ cookieSetFn: setFn });

    await adapter.dismissNsfwSplash(ctx, "https://asurascans.com/comics/test-030ff47a/chapter/1");
    const firstCallCount = setFn.mock.calls.length;

    await adapter.dismissNsfwSplash(ctx, "https://asurascans.com/comics/test-030ff47a/chapter/1");
    expect(setFn.mock.calls.length).toBe(firstCallCount * 2);
  });

  it("sets safe_browse=0 cookie", async () => {
    const setFn = vi.fn();
    const ctx = makeMockCtx({ cookieSetFn: setFn });

    await adapter.dismissNsfwSplash(ctx, "https://asurascans.com/chapter/1");

    const cookieNames = setFn.mock.calls.map(
      (call: unknown[]) => (call[0] as { name: string }).name,
    );
    expect(cookieNames).toContain("safe_browse");

    const safeBrowseCall = setFn.mock.calls.find(
      (call: unknown[]) => (call[0] as { name: string }).name === "safe_browse",
    );
    expect(safeBrowseCall?.[0]).toMatchObject({ name: "safe_browse", value: "0" });
  });

  it("sets wpmanga-adult-confirmed=1 cookie", async () => {
    const setFn = vi.fn();
    const ctx = makeMockCtx({ cookieSetFn: setFn });

    await adapter.dismissNsfwSplash(ctx, "https://asurascans.com/chapter/1");

    const call = setFn.mock.calls.find(
      (c: unknown[]) => (c[0] as { name: string }).name === "wpmanga-adult-confirmed",
    );
    expect(call?.[0]).toMatchObject({ name: "wpmanga-adult-confirmed", value: "1" });
  });
});

// ---------------------------------------------------------------------------
// matchHost / domainAliases / liveDomain
// ---------------------------------------------------------------------------

describe("AsuraScansAdapter host matching", () => {
  let adapter: AsuraScansAdapter;

  beforeEach(() => {
    adapter = new AsuraScansAdapter();
  });

  it("matches asurascans.com (canonical domain)", () => {
    expect(adapter.matchHost("asurascans.com")).toBe(true);
  });

  it("matches asuracomic.net (historical primary)", () => {
    expect(adapter.matchHost("asuracomic.net")).toBe(true);
  });

  it("matches asuratoon.com (historical alias)", () => {
    expect(adapter.matchHost("asuratoon.com")).toBe(true);
  });

  it("does not match unrelated hosts", () => {
    expect(adapter.matchHost("manhuaplus.org")).toBe(false);
    expect(adapter.matchHost("example.com")).toBe(false);
    expect(adapter.matchHost("asura.co")).toBe(false);
  });

  it("returns all three known aliases", () => {
    const aliases = adapter.domainAliases();
    expect(aliases).toContain("asurascans.com");
    expect(aliases).toContain("asuracomic.net");
    expect(aliases).toContain("asuratoon.com");
  });

  it("liveDomain() defaults to asurascans.com before any probe", () => {
    // New spec: asurascans.com is the canonical domain and must be the default.
    expect(adapter.liveDomain()).toBe("asurascans.com");
  });

  it("liveDomain() probe order: asurascans.com first", async () => {
    let firstProbedHost = "";
    const ctx = makeMockCtx({
      httpGetFn: (url: string) => {
        const host = new URL(url).hostname;
        if (!firstProbedHost) firstProbedHost = host;
        return { statusCode: 200, body: "<html>ok</html>" };
      },
    });

    await adapter.resolveLiveDomain(ctx);
    expect(firstProbedHost).toBe("asurascans.com");
  });
});

// ---------------------------------------------------------------------------
// adapterRegistry
// ---------------------------------------------------------------------------

describe("adapterRegistry", () => {
  it("routes asurascans.com to asurascans adapter", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    const a = adapterRegistry.matchUrl("https://asurascans.com/comics/test-abc123");
    expect(a).not.toBeNull();
    expect(a!.id).toBe("asurascans");
  });

  it("routes asuracomic.net to asurascans adapter", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    const a = adapterRegistry.matchUrl("https://asuracomic.net/series/test-abc123");
    expect(a).not.toBeNull();
    expect(a!.id).toBe("asurascans");
  });

  it("routes asuratoon.com to asurascans adapter", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    const a = adapterRegistry.matchUrl("https://asuratoon.com/series/test-abc123");
    expect(a).not.toBeNull();
    expect(a!.id).toBe("asurascans");
  });

  it("returns null for unknown host", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    expect(adapterRegistry.matchUrl("https://unknown-source.net/series/test")).toBeNull();
  });

  it("byId('asurascans') returns the adapter", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    const a = adapterRegistry.byId("asurascans");
    expect(a.id).toBe("asurascans");
  });

  it("byId('manhuaplus') returns the adapter", async () => {
    const { adapterRegistry } = await import("../src/adapters/index.js");
    const a = adapterRegistry.byId("manhuaplus");
    expect(a.id).toBe("manhuaplus");
  });
});
