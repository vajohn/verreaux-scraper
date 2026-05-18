import { describe, it, expect, vi, beforeEach } from "vitest";
import { runChapter } from "../src/core/chapterRunner.js";
import type { ChapterRunnerArgs } from "../src/core/chapterRunner.js";
import { EventBus } from "../src/core/events.js";
import type { ChapterMeta, SeriesMeta } from "../src/core/types.js";
import type { Store } from "../src/state/store.js";

vi.mock("../src/core/imageRunner.js", () => {
  return {
    runImage: vi.fn(),
    RateLimitExhaustedError: class RateLimitExhaustedError extends Error {
      code = "ERR_RATE_LIMIT_EXHAUSTED";
      name = "RateLimitExhaustedError";
    },
    InvalidImageFormatError: class InvalidImageFormatError extends Error {
      code = "ERR_BAD_MAGIC";
      name = "InvalidImageFormatError";
    },
  };
});

import { runImage } from "../src/core/imageRunner.js";
const mockRunImage = runImage as ReturnType<typeof vi.fn>;

const VALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, ...new Array(100).fill(0x00),
]);

function makeChapter(n: number = 1): ChapterMeta {
  return {
    canonicalChapterId: `series:ch${n}`,
    number: n,
    title: `Chapter ${n}`,
    urlAtRun: `https://example.com/chapter/${n}`,
    order: 0,
  };
}

function makeSeriesMeta(): SeriesMeta {
  return {
    sourceId: "asurascans",
    canonicalSeriesId: "series:test",
    urlAtRun: "https://example.com/series/test",
    title: "Test Series",
    coverUrl: "https://example.com/cover.webp",
    chapters: [],
  };
}

function makeStubAdapter(pages = [
  { pageIndex: 1, imageUrl: "https://cdn.example.com/1.webp", referer: "https://example.com/chapter/1" },
  { pageIndex: 2, imageUrl: "https://cdn.example.com/2.webp", referer: "https://example.com/chapter/1" },
]) {
  return {
    id: "asurascans" as const,
    matchHost: vi.fn(),
    domainAliases: vi.fn().mockReturnValue([]),
    resolveSeries: vi.fn(),
    enumerateChapters: vi.fn(),
    parseChapterImages: vi.fn().mockResolvedValue(pages),
    imageRefererFor: vi.fn().mockReturnValue("https://example.com/chapter/1"),
    dismissNsfwSplash: vi.fn(),
    liveDomain: vi.fn().mockReturnValue("example.com"),
  };
}

function makeStore(existingChapterRows: { chapter_number: number; state: string; expected_page_count?: number }[] = [], existingPageRows: { page_index: number; state: string; sha1?: string; bytes?: number; ext?: string }[] = []): Store {
  return {
    cookies: {} as Store["cookies"],
    runs: {} as Store["runs"],
    chapters: {
      byRun: vi.fn().mockReturnValue(existingChapterRows),
      upsert: vi.fn(),
      markStatus: vi.fn(),
    },
    pages: {
      byChapter: vi.fn().mockReturnValue(existingPageRows),
      upsert: vi.fn(),
      markStatus: vi.fn(),
    },
    hashes: { has: vi.fn().mockReturnValue(false), put: vi.fn() },
    close: vi.fn(),
  } as unknown as Store;
}

function makeHttp(statusCode = 200, body = "page html") {
  return {
    get: vi.fn().mockResolvedValue({ statusCode, body, headers: {} }),
    isCloudflareChallenged: vi.fn().mockReturnValue(false),
  };
}

function makeStaging() {
  return {
    writePage: vi.fn().mockResolvedValue("/staging/ch/001.webp"),
    writeCover: vi.fn(),
    removeChapter: vi.fn(),
    listChapters: vi.fn().mockResolvedValue([]),
    rootPath: "/staging",
  };
}

function makeThrottler() {
  return {
    pauseHost: vi.fn(),
    resumeHost: vi.fn(),
    scheduleForHost: vi.fn((_, fn) => fn()),
    scheduleForImageHost: vi.fn((_, fn) => fn()),
    withCfMutex: vi.fn((_, fn) => fn()),
    adjustConcurrency: vi.fn(),
  };
}

function makeAdapterCtx() {
  return {
    http: {} as any,
    browser: {} as any,
    cookies: {} as any,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    throttle: makeThrottler() as any,
    signal: new AbortController().signal,
  };
}

function makeArgs(overrides: Partial<ChapterRunnerArgs> = {}): ChapterRunnerArgs {
  const eventBus = new EventBus();
  const chapter = makeChapter();
  const seriesMeta = makeSeriesMeta();
  const adapter = makeStubAdapter();
  const store = makeStore();
  const http = makeHttp();
  const staging = makeStaging();
  const throttler = makeThrottler();
  const adapterCtx = makeAdapterCtx();
  const signal = new AbortController().signal;

  return {
    chapter,
    seriesMeta,
    runId: "run-1",
    adapter: adapter as unknown as ChapterRunnerArgs["adapter"],
    adapterCtx: adapterCtx as unknown as ChapterRunnerArgs["adapterCtx"],
    staging: staging as unknown as ChapterRunnerArgs["staging"],
    http: http as unknown as ChapterRunnerArgs["http"],
    store: store as unknown as ChapterRunnerArgs["store"],
    eventBus,
    throttler: throttler as unknown as ChapterRunnerArgs["throttler"],
    signal,
    ...overrides,
  };
}

describe("chapterRunner", () => {
  beforeEach(() => {
    mockRunImage.mockReset();
    let callIdx = 0;
    mockRunImage.mockImplementation(() => {
      callIdx++;
      const padded = String(callIdx).padStart(40, "0");
      return Promise.resolve({
        sha1: padded,
        byteLength: VALID_WEBP.length,
        ext: ".webp",
      });
    });
  });

  describe("happy path", () => {
    it("returns completed status with correct page count", async () => {
      const result = await runChapter(makeArgs());
      expect(result.status).toBe("completed");
      expect(result.pageCount).toBe(2);
    });

    it("marks chapter DONE in store", async () => {
      const store = makeStore();
      await runChapter(makeArgs({ store: store as unknown as Store }));
      expect(store.chapters.markStatus).toHaveBeenCalledWith(
        "run-1", 1, "DONE", expect.anything(),
      );
    });

    it("emits chapter.done event", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));
      await runChapter(makeArgs({ eventBus }));
      expect(events).toContain("chapter.done");
    });

    it("emits chapter.verified event", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));
      await runChapter(makeArgs({ eventBus }));
      expect(events).toContain("chapter.verified");
    });

    it("emits chapter.images_parsed with correct count", async () => {
      const eventBus = new EventBus();
      const payloads: Array<{ type: string; payload: unknown }> = [];
      eventBus.on((e) => payloads.push({ type: e.type, payload: e.payload }));
      await runChapter(makeArgs({ eventBus }));
      const parsed = payloads.find((e) => e.type === "chapter.images_parsed");
      expect(parsed).toBeDefined();
      expect((parsed!.payload as { pageCount: number }).pageCount).toBe(2);
    });
  });

  describe("resume from partial", () => {
    it("skips pages already in DONE state", async () => {
      const store = makeStore(
        [],
        [{ page_index: 1, state: "DONE", sha1: "aa", bytes: 100, ext: ".webp" }],
      );
      const args = makeArgs({ store: store as unknown as Store });
      const result = await runChapter(args);
      expect(result.status).toBe("completed");
      expect(mockRunImage).toHaveBeenCalledTimes(1);
    });

    it("returns no-op when chapter is already DONE in store", async () => {
      const store = makeStore(
        [{ chapter_number: 1, state: "DONE", expected_page_count: 5 }],
      );
      const http = makeHttp();
      const args = makeArgs({ store: store as unknown as Store, http: http as unknown as ChapterRunnerArgs["http"] });
      const result = await runChapter(args);
      expect(result.status).toBe("completed");
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe("placeholder detection", () => {
    it("fails chapter when all pages have identical SHA-1", async () => {
      const sha1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      mockRunImage.mockResolvedValue({ sha1, byteLength: 1000, ext: ".webp" });

      const eventBus = new EventBus();
      const events: Array<{ type: string; payload: unknown }> = [];
      eventBus.on((e) => events.push({ type: e.type, payload: e.payload }));

      const result = await runChapter(makeArgs({ eventBus }));

      expect(result.status).toBe("failed");
      const failedEvent = events.find((e) => e.type === "chapter.failed");
      expect(failedEvent).toBeDefined();
      expect((failedEvent!.payload as { code: string }).code).toBe("ERR_PLACEHOLDER_DETECTED");
    });

    it("passes when pages have two distinct SHA-1 hashes", async () => {
      mockRunImage
        .mockResolvedValueOnce({ sha1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", byteLength: 1000, ext: ".webp" })
        .mockResolvedValueOnce({ sha1: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", byteLength: 1000, ext: ".webp" });

      const result = await runChapter(makeArgs());
      expect(result.status).toBe("completed");
    });

    it("does NOT fail a single-page chapter just because its one hash is 'unique-but-singleton'", async () => {
      // Real-world: chapter 41.5 of a manhuaplus series had pageCount=1, which
      // trivially produces uniqueHashes.size === 1 — the placeholder check
      // must require ≥2 pages to be meaningful.
      mockRunImage.mockResolvedValue({
        sha1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 1000,
        ext: ".webp",
      });
      const adapter = makeStubAdapter([
        { pageIndex: 1, imageUrl: "https://cdn.example.com/1.webp", referer: "" },
      ]);

      const result = await runChapter(
        makeArgs({ adapter: adapter as unknown as ChapterRunnerArgs["adapter"] }),
      );
      expect(result.status).toBe("completed");
      expect(result.pageCount).toBe(1);
    });
  });

  describe("missing pages tolerance", () => {
    it("succeeds when ≤2 pages return 404", async () => {
      const err404 = Object.assign(new Error("Image 404"), { code: "ERR_IMAGE_404" });
      mockRunImage
        .mockRejectedValueOnce(err404)
        .mockRejectedValueOnce(err404)
        .mockResolvedValueOnce({ sha1: "cc".padEnd(40, "c"), byteLength: 100, ext: ".webp" })
        .mockResolvedValueOnce({ sha1: "dd".padEnd(40, "d"), byteLength: 100, ext: ".webp" });

      const adapter = makeStubAdapter([
        { pageIndex: 1, imageUrl: "https://cdn.example.com/1.webp", referer: "" },
        { pageIndex: 2, imageUrl: "https://cdn.example.com/2.webp", referer: "" },
        { pageIndex: 3, imageUrl: "https://cdn.example.com/3.webp", referer: "" },
        { pageIndex: 4, imageUrl: "https://cdn.example.com/4.webp", referer: "" },
      ]);

      const result = await runChapter(makeArgs({ adapter: adapter as unknown as ChapterRunnerArgs["adapter"] }));
      expect(result.status).toBe("completed");
    });

    it("fails chapter when >2 pages are missing", async () => {
      const err404 = Object.assign(new Error("Image 404"), { code: "ERR_IMAGE_404" });
      mockRunImage.mockRejectedValue(err404);

      const adapter = makeStubAdapter([
        { pageIndex: 1, imageUrl: "https://cdn.example.com/1.webp", referer: "" },
        { pageIndex: 2, imageUrl: "https://cdn.example.com/2.webp", referer: "" },
        { pageIndex: 3, imageUrl: "https://cdn.example.com/3.webp", referer: "" },
        { pageIndex: 4, imageUrl: "https://cdn.example.com/4.webp", referer: "" },
      ]);

      const result = await runChapter(makeArgs({ adapter: adapter as unknown as ChapterRunnerArgs["adapter"] }));
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ERR_TOO_MANY_MISSING");
    });
  });

  describe("zero images", () => {
    it("fails chapter when adapter returns zero images", async () => {
      const adapter = makeStubAdapter([]);
      const eventBus = new EventBus();
      const events: Array<{ type: string; payload: unknown }> = [];
      eventBus.on((e) => events.push({ type: e.type, payload: e.payload }));

      const result = await runChapter(makeArgs({ adapter: adapter as unknown as ChapterRunnerArgs["adapter"], eventBus }));
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ERR_CHAPTER_EMPTY");
    });
  });

  describe("http error on chapter fetch", () => {
    it("fails chapter on 404", async () => {
      const http = makeHttp(404);
      const result = await runChapter(makeArgs({ http: http as unknown as ChapterRunnerArgs["http"] }));
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("ERR_CHAPTER_404");
    });
  });
});
