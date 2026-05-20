import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterContext, ChapterStub, ResolvedSeries } from "../src/core/types.js";
import type { HttpClient } from "../src/transport/http.js";
import type { Response } from "got";
import { hivetoonsAdapter, HivetoonsParseError } from "../src/adapters/hivetoons.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/hivetoons", name), "utf8");
}

function mockResponse(body: string, statusCode = 200): Response<string> {
  return {
    body,
    statusCode,
    headers: {},
    url: "",
    requestUrl: new URL("https://hivetoons.org/"),
    timings: {},
    retryCount: 0,
    redirectUrls: [],
    ip: undefined,
    isFromCache: false,
    ok: statusCode >= 200 && statusCode < 300,
  } as unknown as Response<string>;
}

function buildMockContext(getImpl: (url: string, opts?: unknown) => Promise<Response<string>>) {
  const getCalls: Array<{ url: string; opts: unknown }> = [];

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

    browser: {
      renderPage: vi.fn(async (_url: string, _opts?: unknown) => ({ content: "", status: 200 } as any)),
    } as any,

    cookies: {
      set: vi.fn(),
      serializeForHost: vi.fn(async () => ""),
      hasFreshCfClearance: vi.fn(() => false),
    } as any,

    logger: noopLogger as any,

    throttle: { scheduleForHost: vi.fn((_h: unknown, f: () => unknown) => f()) } as any,
    signal: new AbortController().signal,
  };

  return { ctx, getCalls };
}

describe("HivetoonsAdapter.matchHost", () => {
  it("returns true for hivetoons.org", () => {
    expect(hivetoonsAdapter.matchHost("hivetoons.org")).toBe(true);
    expect(hivetoonsAdapter.matchHost("www.hivetoons.org")).toBe(true);
  });
});

describe("HivetoonsAdapter.resolveSeries", () => {
  const SERIES_URL = "https://hivetoons.org/series/eleceed";

  it("parses title, cover and preEnumeratedChapters from fixture", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("series.html")));
    const result = await hivetoonsAdapter.resolveSeries(ctx, SERIES_URL);
    expect(result.seriesTitle).toBe("Eleceed");
    expect(result.coverUrl).toBe("https://hivetoons.cdn/eleceed/cover.jpg");
    expect(result.preEnumeratedChapters).toHaveLength(3);
  });

  it("throws HivetoonsParseError when page lacks title", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(`<html><body></body></html>`));
    await expect(hivetoonsAdapter.resolveSeries(ctx, SERIES_URL)).rejects.toThrow(HivetoonsParseError);
  });
});

describe("HivetoonsAdapter.parseChapterImages", () => {
  const CHAPTER_STUB: ChapterStub = { chapterNumber: 1, chapterTitle: null, chapterUrl: "https://hivetoons.org/series/eleceed/chapter-1" };

  it("returns PageStubs for images found in chapter HTML", async () => {
    const { ctx } = buildMockContext(async () => mockResponse(fixture("chapter.html")));
    const html = fixture("chapter.html");
    const pages = await hivetoonsAdapter.parseChapterImages(ctx, CHAPTER_STUB, html);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[0].pageIndex).toBe(1);
    expect(pages[0].referer).toBe(CHAPTER_STUB.chapterUrl);
  });
});

