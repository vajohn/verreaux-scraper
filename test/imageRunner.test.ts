import { describe, it, expect, vi, beforeEach } from "vitest";
import { runImage, InvalidImageFormatError, RateLimitExhaustedError, ImageUnavailableError } from "../src/core/imageRunner.js";
import type { ImageRunnerArgs } from "../src/core/imageRunner.js";
import { EventBus } from "../src/core/events.js";
import type { PageMeta, ChapterMeta } from "../src/core/types.js";
import type { Store } from "../src/state/store.js";

const VALID_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46,
  0x00, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
  ...new Array(100).fill(0x00),
]);

const VALID_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(100).fill(0x00)]);

const INVALID_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

function makeChapter(n: number = 1): ChapterMeta {
  return {
    canonicalChapterId: `s:ch${n}`,
    number: n,
    title: `Chapter ${n}`,
    urlAtRun: `https://example.com/chapter/${n}`,
    order: 0,
  };
}

function makePage(pageNumber: number = 1, url: string = "https://cdn.example.com/1.webp"): PageMeta {
  return { pageNumber, url };
}

function makeStore(overrides?: Partial<Store["pages"]>): Store {
  return {
    cookies: {} as Store["cookies"],
    runs: {} as Store["runs"],
    chapters: {} as Store["chapters"],
    pages: {
      byChapter: vi.fn().mockReturnValue([]),
      upsert: vi.fn(),
      markStatus: vi.fn(),
      ...overrides,
    },
    hashes: { has: vi.fn().mockReturnValue(false), put: vi.fn() },
    close: vi.fn(),
  } as unknown as Store;
}

function makeHttpClient(statusCode: number, body: Buffer, extraHeaders: Record<string, string> = {}) {
  return {
    getImage: vi.fn().mockResolvedValue({
      statusCode,
      body,
      headers: { "content-type": "image/webp", ...extraHeaders },
    }),
    isCloudflareChallenged: vi.fn().mockReturnValue(false),
  };
}

function makeAdapter() {
  return {
    id: "asurascans" as const,
    matchHost: vi.fn(),
    domainAliases: vi.fn().mockReturnValue([]),
    resolveSeries: vi.fn(),
    enumerateChapters: vi.fn(),
    parseChapterImages: vi.fn(),
    imageRefererFor: vi.fn().mockReturnValue("https://example.com"),
    dismissNsfwSplash: vi.fn(),
    liveDomain: vi.fn().mockReturnValue("example.com"),
  };
}

function makeStaging() {
  return {
    writePage: vi.fn().mockResolvedValue("/staging/chapter/001.webp"),
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

function makeArgs(
  overrides: Partial<ImageRunnerArgs> = {},
): ImageRunnerArgs {
  const eventBus = new EventBus();
  const chapter = makeChapter();
  const page = makePage();
  const http = makeHttpClient(200, VALID_WEBP);
  const store = makeStore();
  const adapter = makeAdapter();
  const staging = makeStaging();
  const throttler = makeThrottler();
  const signal = new AbortController().signal;

  return {
    page,
    chapter,
    adapter: adapter as unknown as ImageRunnerArgs["adapter"],
    staging: staging as unknown as ImageRunnerArgs["staging"],
    http: http as unknown as ImageRunnerArgs["http"],
    store: store as unknown as ImageRunnerArgs["store"],
    eventBus,
    throttler: throttler as unknown as ImageRunnerArgs["throttler"],
    runId: "run-1",
    signal,
    ...overrides,
  };
}

describe("imageRunner", () => {
  describe("happy path", () => {
    it("returns sha1, byteLength, and ext on success", async () => {
      const args = makeArgs();
      const result = await runImage(args);

      expect(result.ext).toBe(".webp");
      expect(result.byteLength).toBe(VALID_WEBP.length);
      expect(result.sha1).toMatch(/^[0-9a-f]{40}$/);
    });

    it("emits page.bytes, page.ok, page.hashed, page.done events", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      await runImage(makeArgs({ eventBus }));

      expect(events).toContain("page.bytes");
      expect(events).toContain("page.ok");
      expect(events).toContain("page.hashed");
      expect(events).toContain("page.done");
    });

    it("writes to staging", async () => {
      const staging = makeStaging();
      await runImage(makeArgs({ staging: staging as unknown as ImageRunnerArgs["staging"] }));
      expect(staging.writePage).toHaveBeenCalledWith(1, 1, VALID_WEBP, expect.stringContaining("image"));
    });

    it("marks page DONE in store", async () => {
      const store = makeStore();
      await runImage(makeArgs({ store: store as unknown as Store }));
      expect(store.pages.markStatus).toHaveBeenCalledWith(
        "run-1", 1, 1, "DONE",
        expect.objectContaining({ sha1: expect.any(String), bytes: VALID_WEBP.length, ext: ".webp" }),
      );
    });
  });

  describe("idempotency", () => {
    it("returns persisted record without re-downloading if page is already DONE", async () => {
      const store = makeStore({
        byChapter: vi.fn().mockReturnValue([
          {
            page_index: 1,
            state: "DONE",
            sha1: "aabbccddeeff00112233445566778899aabbccdd",
            bytes: 999,
            ext: ".jpg",
          },
        ]),
      });
      const http = makeHttpClient(200, VALID_WEBP);
      const args = makeArgs({ store: store as unknown as Store, http: http as unknown as ImageRunnerArgs["http"] });

      const result = await runImage(args);

      expect(result.sha1).toBe("aabbccddeeff00112233445566778899aabbccdd");
      expect(result.byteLength).toBe(999);
      expect(result.ext).toBe(".jpg");
      expect(http.getImage).not.toHaveBeenCalled();
    });
  });

  describe("magic-byte verify", () => {
    it("throws InvalidImageFormatError for unrecognised bytes", async () => {
      const http = makeHttpClient(200, INVALID_BYTES);
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"] });
      await expect(runImage(args)).rejects.toThrow(InvalidImageFormatError);
    });

    it("emits page.hash_fail for invalid bytes", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));
      const http = makeHttpClient(200, INVALID_BYTES);
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], eventBus });
      await runImage(args).catch(() => {});
      expect(events).toContain("page.hash_fail");
    });

    it("detects JPEG magic bytes and returns .jpg ext", async () => {
      const http = makeHttpClient(200, VALID_JPEG);
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"] });
      const result = await runImage(args);
      expect(result.ext).toBe(".jpg");
    });
  });

  describe("404 handling", () => {
    it("emits page.404 and throws ImageNotFoundError", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      const http = makeHttpClient(404, Buffer.alloc(0));
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], eventBus });

      const err = await runImage(args).catch((e) => e as Error);
      expect(err).toBeDefined();
      expect((err as { code?: string }).code).toBe("ERR_IMAGE_404");
      expect(events).toContain("page.404");
    });
  });

  describe("403 handling", () => {
    it("throws ImageUnavailableError for 403 with correct referer", async () => {
      const http = {
        getImage: vi.fn().mockResolvedValue({ statusCode: 403, body: Buffer.alloc(0), headers: {} }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };
      const page = makePage(1, "https://cdn.example.com/1.webp");
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], page });
      await expect(runImage(args)).rejects.toThrow(ImageUnavailableError);
    });
  });

  describe("429 backoff", () => {
    it("retries on 429 and succeeds if retry resolves", async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const http = {
        getImage: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount < 2) {
            return Promise.resolve({
              statusCode: 429,
              body: Buffer.alloc(0),
              headers: { "retry-after": "0" },
            });
          }
          return Promise.resolve({
            statusCode: 200,
            body: VALID_WEBP,
            headers: { "content-type": "image/webp" },
          });
        }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };

      const throttler = makeThrottler();
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], throttler: throttler as unknown as ImageRunnerArgs["throttler"] });

      const promise = runImage(args);
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.sha1).toMatch(/^[0-9a-f]{40}$/);
      expect(callCount).toBe(2);
      vi.useRealTimers();
    }, 10000);

    it("throws RateLimitExhaustedError after 3 retries", async () => {
      vi.useFakeTimers();
      const http = {
        getImage: vi.fn().mockResolvedValue({
          statusCode: 429,
          body: Buffer.alloc(0),
          headers: {},
        }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };

      const throttler = makeThrottler();
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], throttler: throttler as unknown as ImageRunnerArgs["throttler"] });

      let caught: unknown;
      const promise = runImage(args).catch((e) => { caught = e; });
      await vi.runAllTimersAsync();
      await promise;
      expect(caught).toBeInstanceOf(RateLimitExhaustedError);
      vi.useRealTimers();
    }, 10000);

    it("emits page.429 event on rate limit hit", async () => {
      vi.useFakeTimers();
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      const http = {
        getImage: vi.fn().mockResolvedValue({ statusCode: 429, body: Buffer.alloc(0), headers: {} }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };

      const throttler = makeThrottler();
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], eventBus, throttler: throttler as unknown as ImageRunnerArgs["throttler"] });

      const promise = runImage(args).catch(() => {});
      await vi.runAllTimersAsync();
      await promise;
      expect(events).toContain("page.429");
      vi.useRealTimers();
    }, 10000);

    it("emits rate.exhausted after budget exhausted", async () => {
      vi.useFakeTimers();
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      const http = {
        getImage: vi.fn().mockResolvedValue({ statusCode: 429, body: Buffer.alloc(0), headers: {} }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };

      const throttler = makeThrottler();
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], eventBus, throttler: throttler as unknown as ImageRunnerArgs["throttler"] });

      const promise = runImage(args).catch(() => {});
      await vi.runAllTimersAsync();
      await promise;
      expect(events).toContain("rate.exhausted");
      vi.useRealTimers();
    }, 10000);
  });

  describe("5xx retry", () => {
    it("retries 3 times then throws on persistent 5xx", async () => {
      vi.useFakeTimers();
      const http = makeHttpClient(503, Buffer.alloc(0));
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"] });

      let caught: unknown;
      const promise = runImage(args).catch((e) => { caught = e; });
      await vi.runAllTimersAsync();
      await promise;
      expect(caught).toBeDefined();
      expect(http.getImage).toHaveBeenCalledTimes(4);
      vi.useRealTimers();
    }, 10000);

    it("emits page.5xx on server error", async () => {
      vi.useFakeTimers();
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      const http = makeHttpClient(503, Buffer.alloc(0));
      const args = makeArgs({ http: http as unknown as ImageRunnerArgs["http"], eventBus });

      const promise = runImage(args).catch(() => {});
      await vi.runAllTimersAsync();
      await promise;
      expect(events).toContain("page.5xx");
      vi.useRealTimers();
    }, 10000);
  });

  describe("dedup detection", () => {
    it("emits page.sha1_drift when another page in chapter has same sha1", async () => {
      const eventBus = new EventBus();
      const events: string[] = [];
      eventBus.on((e) => events.push(e.type));

      const sha1 = "9cda55f7044958206af3ce227d393fe95fcbe21c";

      const store = makeStore({
        byChapter: vi.fn().mockReturnValue([
          { page_index: 2, state: "DONE", sha1, bytes: VALID_WEBP.length, ext: ".webp" },
        ]),
        markStatus: vi.fn(),
      });

      const http = {
        getImage: vi.fn().mockResolvedValue({
          statusCode: 200,
          body: VALID_WEBP,
          headers: { "content-type": "image/webp" },
        }),
        isCloudflareChallenged: vi.fn().mockReturnValue(false),
      };

      const page = makePage(1);
      const args = makeArgs({ store: store as unknown as Store, http: http as unknown as ImageRunnerArgs["http"], eventBus, page });

      await runImage(args);
      expect(events).toContain("page.sha1_drift");
    });
  });
});
