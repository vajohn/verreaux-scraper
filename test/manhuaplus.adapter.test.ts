// ---------------------------------------------------------------------------
// manhuaplus.adapter.test.ts — adapter-level tests using liliana-theme fixtures.
//
// Fixtures loaded from test/fixtures/manhuaplus-liliana/.
// No real network requests are made — ctx.http.get is a vi.fn().
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, ChapterStub, ResolvedSeries } from "../src/core/types.js";
import type { HttpClient } from "../src/transport/http.js";
import type { Response } from "got";
import { manhuaPlusAdapter, LilianaParseError } from "../src/adapters/manhuaplus.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures/manhuaplus-liliana", name),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function mockResponse(body: string, statusCode = 200): Response<string> {
  return {
    body,
    statusCode,
    headers: {},
    url: "",
    requestUrl: new URL("https://manhuaplus.org/"),
    timings: {},
    retryCount: 0,
    redirectUrls: [],
    ip: undefined,
    isFromCache: false,
    ok: statusCode >= 200 && statusCode < 300,
  } as unknown as Response<string>;
}

interface MockCookieEntry {
  name: string;
  value: string;
  domain: string;
}

function buildMockContext(
  getImpl: (url: string, opts?: unknown) => Promise<Response<string>>,
): {
  ctx: AdapterContext;
  getCalls: Array<{ url: string; opts: unknown }>;
  cookiesSet: MockCookieEntry[];
} {
  const getCalls: Array<{ url: string; opts: unknown }> = [];
  const cookiesSet: MockCookieEntry[] = [];

  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const ctx: AdapterContext = {
    http: {
      get: vi.fn(async (url: string, opts?: unknown) => {
        getCalls.push({ url, opts });
        return getImpl(url, opts);
      }),
      post: vi.fn(async () => mockResponse("")),
    } as unknown as HttpClient,

    browser: {} as AdapterContext["browser"],

    cookies: {
      set: vi.fn((rec: MockCookieEntry) => {
        cookiesSet.push({ name: rec.name, value: rec.value, domain: rec.domain });
      }),
      serializeForHost: vi.fn(async () => ""),
      hasFreshCfClearance: vi.fn(() => false),
    } as unknown as AdapterContext["cookies"],

    logger: noopLogger as unknown as AdapterContext["logger"],

    throttle: {
      scheduleForHost: vi.fn((_host: unknown, fn: () => unknown) => fn()),
    } as unknown as AdapterContext["throttle"],

    signal: new AbortController().signal,
  };

  return { ctx, getCalls, cookiesSet };
}

// ---------------------------------------------------------------------------
// matchHost
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.matchHost", () => {
  it("returns true for manhuaplus.org", () => {
    expect(manhuaPlusAdapter.matchHost("manhuaplus.org")).toBe(true);
  });

  it("returns true for www.manhuaplus.org", () => {
    expect(manhuaPlusAdapter.matchHost("www.manhuaplus.org")).toBe(true);
  });

  it("returns false for unrelated hosts", () => {
    expect(manhuaPlusAdapter.matchHost("asuracomic.net")).toBe(false);
    expect(manhuaPlusAdapter.matchHost("manhuaplus.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// liveDomain
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.liveDomain", () => {
  it("returns manhuaplus.org", () => {
    expect(manhuaPlusAdapter.liveDomain()).toBe("manhuaplus.org");
  });

  it("returns the same value on repeated calls", () => {
    const first = manhuaPlusAdapter.liveDomain();
    const second = manhuaPlusAdapter.liveDomain();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// imageRefererFor
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.imageRefererFor", () => {
  const stubChapter: ChapterStub = {
    chapterNumber: 0,
    chapterTitle: null,
    chapterUrl:
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-0",
  };

  it("returns the chapter URL (required by CDN)", () => {
    expect(manhuaPlusAdapter.imageRefererFor(stubChapter)).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-0",
    );
  });

  it("returns a different URL for a different chapter", () => {
    const ch1: ChapterStub = {
      chapterNumber: 1,
      chapterTitle: null,
      chapterUrl:
        "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-1",
    };
    expect(manhuaPlusAdapter.imageRefererFor(ch1)).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-1",
    );
  });
});

// ---------------------------------------------------------------------------
// dismissNsfwSplash
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.dismissNsfwSplash", () => {
  it("sets all three bypass cookies on manhuaplus.org domain", async () => {
    const { ctx, cookiesSet } = buildMockContext(async () =>
      mockResponse(fixture("series.html")),
    );

    await manhuaPlusAdapter.dismissNsfwSplash(ctx, "https://manhuaplus.org/manga/test/");

    const names = cookiesSet.map((c) => c.name);
    expect(names).toContain("wpmanga-adult-confirmed");
    expect(names).toContain("mature-content-allow");
    expect(names).toContain("age_verified");

    const adultConfirm = cookiesSet.find((c) => c.name === "wpmanga-adult-confirmed");
    expect(adultConfirm?.value).toBe("1");
    expect(adultConfirm?.domain).toBe("manhuaplus.org");
  });

  it("is idempotent — calling it twice does not throw", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));

    await expect(
      manhuaPlusAdapter.dismissNsfwSplash(ctx, "https://manhuaplus.org/manga/test/"),
    ).resolves.toBeUndefined();
    await expect(
      manhuaPlusAdapter.dismissNsfwSplash(ctx, "https://manhuaplus.org/manga/test/"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveSeries
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.resolveSeries", () => {
  const SERIES_URL =
    "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed";

  it("returns correct title from live series fixture", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    expect(result.seriesTitle).toBe(
      "The Third Prince of the Fallen Kingdom has Regressed",
    );
  });

  it("returns the og:image cover URL", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    expect(result.coverUrl).toBe(
      "https://manhuaplus.org/uploads/covers/the-third-prince-of-the-fallen-kingdom-has-regressed.jpg",
    );
  });

  it("returns coverReferer as origin with trailing slash", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    expect(result.coverReferer).toBe("https://manhuaplus.org/");
  });

  it("returns 71 pre-enumerated chapters sorted ascending", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    const chapters = result.preEnumeratedChapters ?? [];
    expect(chapters).toHaveLength(71);
    // Sorted ascending: chapter 0 first, chapter 70 last
    expect(chapters[0]?.chapterNumber).toBe(0);
    expect(chapters[chapters.length - 1]?.chapterNumber).toBe(70);
  });

  it("chapter 0 URL is correct", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    const chapters = result.preEnumeratedChapters ?? [];
    const ch0 = chapters.find((c) => c.chapterNumber === 0);
    expect(ch0?.chapterUrl).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-0",
    );
  });

  it("chapter 70 URL is correct", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    const chapters = result.preEnumeratedChapters ?? [];
    const ch70 = chapters.find((c) => c.chapterNumber === 70);
    expect(ch70?.chapterUrl).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-70",
    );
  });

  it("sets NSFW bypass cookies before fetching", async () => {
    const { ctx, cookiesSet } = buildMockContext(async () =>
      mockResponse(fixture("series.html")),
    );
    await manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL);
    const names = cookiesSet.map((c) => c.name);
    expect(names).toContain("wpmanga-adult-confirmed");
    expect(names).toContain("mature-content-allow");
    expect(names).toContain("age_verified");
  });

  it("throws LilianaParseError when the page has no title element", async () => {
    const emptyHtml = `<html><body><p>nothing</p></body></html>`;
    const { ctx } = buildMockContext(async () => mockResponse(emptyHtml));
    await expect(
      manhuaPlusAdapter.resolveSeries(ctx, SERIES_URL),
    ).rejects.toThrow(LilianaParseError);
  });
});

// ---------------------------------------------------------------------------
// enumerateChapters
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.enumerateChapters", () => {
  const SERIES_URL =
    "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed";

  it("returns pre-enumerated chapters directly without re-fetching", async () => {
    const preEnumerated: readonly ChapterStub[] = [
      { chapterNumber: 0, chapterTitle: null, chapterUrl: `${SERIES_URL}/chapter-0` },
      { chapterNumber: 1, chapterTitle: null, chapterUrl: `${SERIES_URL}/chapter-1` },
    ];
    const series: ResolvedSeries = {
      seriesId: SERIES_URL,
      seriesTitle: "Test",
      coverUrl: "",
      coverReferer: "https://manhuaplus.org/",
      preEnumeratedChapters: preEnumerated,
    };

    const { ctx, getCalls } = buildMockContext(async () => mockResponse(""));
    const chapters = await manhuaPlusAdapter.enumerateChapters(ctx, series);

    // Should not have made any HTTP calls
    expect(getCalls).toHaveLength(0);
    expect(chapters).toHaveLength(2);
  });

  it("re-fetches series when preEnumeratedChapters is absent", async () => {
    const series: ResolvedSeries = {
      seriesId: SERIES_URL,
      seriesTitle: "Test",
      coverUrl: "",
      coverReferer: "https://manhuaplus.org/",
      preEnumeratedChapters: undefined,
    };

    const { ctx, getCalls } = buildMockContext(async () =>
      mockResponse(fixture("series.html")),
    );
    const chapters = await manhuaPlusAdapter.enumerateChapters(ctx, series);

    expect(getCalls.length).toBeGreaterThan(0);
    expect(chapters.length).toBe(71);
  });
});

// ---------------------------------------------------------------------------
// parseChapterImages
// ---------------------------------------------------------------------------

describe("ManhuaPlusAdapter.parseChapterImages", () => {
  const CHAPTER_URL =
    "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-0";

  const stubChapter: ChapterStub = {
    chapterNumber: 0,
    chapterTitle: null,
    chapterUrl: CHAPTER_URL,
  };

  it("extracts 7 page image URLs from the live chapter fixture via image-list API", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx } = buildMockContext(async (url) => {
      if (url.includes("/ajax/image/list/chap/")) {
        return mockResponse(imageListJson);
      }
      return mockResponse("");
    });

    const pages = await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);
    expect(pages).toHaveLength(7);
  });

  it("calls the image-list endpoint with the correct CHAPTER_ID (78093)", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx, getCalls } = buildMockContext(async () => mockResponse(imageListJson));

    await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);

    const imageListCall = getCalls.find((c) => c.url.includes("/ajax/image/list/chap/"));
    expect(imageListCall).toBeDefined();
    expect(imageListCall?.url).toBe(
      "https://manhuaplus.org/ajax/image/list/chap/78093",
    );
  });

  it("sends X-Requested-With: XMLHttpRequest header on image-list request", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx, getCalls } = buildMockContext(async () => mockResponse(imageListJson));

    await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);

    const imageListCall = getCalls.find((c) => c.url.includes("/ajax/image/list/chap/"));
    const opts = imageListCall?.opts as { headers?: Record<string, string> };
    expect(opts?.headers?.["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("sends chapter URL as referer on the image-list request", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx, getCalls } = buildMockContext(async () => mockResponse(imageListJson));

    await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);

    const imageListCall = getCalls.find((c) => c.url.includes("/ajax/image/list/chap/"));
    const opts = imageListCall?.opts as { referer?: string };
    expect(opts?.referer).toBe(CHAPTER_URL);
  });

  it("all image URLs are from cdn.manhuaplus.cc", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx } = buildMockContext(async () => mockResponse(imageListJson));

    const pages = await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);
    for (const page of pages) {
      expect(page.imageUrl).toMatch(/^https:\/\/cdn\.manhuaplus\.cc\//);
    }
  });

  it("assigns 1-indexed pageIndex values in reading order", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx } = buildMockContext(async () => mockResponse(imageListJson));

    const pages = await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);
    expect(pages[0]?.pageIndex).toBe(1);
    expect(pages[6]?.pageIndex).toBe(7);
  });

  it("sets referer to the chapter URL on every PageStub", async () => {
    const chapterHtml = fixture("chapter.html");
    const imageListJson = fixture("image-list.json");

    const { ctx } = buildMockContext(async () => mockResponse(imageListJson));

    const pages = await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);
    for (const page of pages) {
      expect(page.referer).toBe(CHAPTER_URL);
    }
  });

  it("returns empty array when CHAPTER_ID is missing from chapter HTML", async () => {
    const { ctx } = buildMockContext(async () => mockResponse("{}"));

    const pages = await manhuaPlusAdapter.parseChapterImages(
      ctx,
      stubChapter,
      "<html><body><p>No chapter ID here</p></body></html>",
    );

    expect(pages).toHaveLength(0);
  });

  it("returns empty array when image-list JSON has status: false", async () => {
    const chapterHtml = fixture("chapter.html");
    const { ctx } = buildMockContext(async () =>
      mockResponse(JSON.stringify({ status: false, html: "" })),
    );

    const pages = await manhuaPlusAdapter.parseChapterImages(ctx, stubChapter, chapterHtml);
    expect(pages).toHaveLength(0);
  });
});
