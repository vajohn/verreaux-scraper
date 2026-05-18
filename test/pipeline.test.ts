import { describe, it, expect, vi, beforeEach } from "vitest";
import { Pipeline } from "../src/core/pipeline.js";
import type { PipelineDeps } from "../src/core/pipeline.js";
import { EventBus } from "../src/core/events.js";
import { ExitCode } from "../src/core/types.js";
import type { RunConfig } from "../src/core/types.js";

vi.mock("../src/adapters/index.js", () => {
  return {
    adapterRegistry: {
      matchUrl: vi.fn(),
      byId: vi.fn(),
    },
  };
});

vi.mock("../src/core/chapterRunner.js", () => {
  return {
    runChapter: vi.fn(),
  };
});

vi.mock("../src/packaging/staging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packaging/staging.js")>();
  return {
    ...actual,
    StagingDir: class MockStagingDir {
      rootPath = "/mock-staging";
      async init() {}
      async writeCover() { return "/mock-staging/cover.webp"; }
      async writePage() { return "/mock-staging/ch/001.webp"; }
      async removeChapter() {}
      async listChapters() { return ["Chapter 001", "Chapter 002"]; }
    },
  };
});

vi.mock("../src/packaging/packager.js", () => {
  return {
    Packager: class MockPackager {
      constructor(private bus: EventBus) {}
      async build(_staging: unknown, opts: { outPath: string; seriesTitle: string }) {
        return {
          path: `${opts.outPath}.zip`,
          byteLength: 1024,
          chapterCount: 2,
          pageCount: 10,
        };
      }
    },
    PackageIncompletenessError: class PackageIncompletenessError extends Error {},
  };
});

import { adapterRegistry } from "../src/adapters/index.js";
import { runChapter } from "../src/core/chapterRunner.js";

const mockAdapterRegistry = adapterRegistry as { matchUrl: ReturnType<typeof vi.fn>; byId: ReturnType<typeof vi.fn> };
const mockRunChapter = runChapter as ReturnType<typeof vi.fn>;

const CHAPTER_STUBS = [
  { chapterNumber: 1, chapterTitle: "Chapter 1", chapterUrl: "https://example.com/ch/1" },
  { chapterNumber: 2, chapterTitle: "Chapter 2", chapterUrl: "https://example.com/ch/2" },
  { chapterNumber: 3, chapterTitle: "Chapter 3", chapterUrl: "https://example.com/ch/3" },
];

function makeAdapter(extraChapters?: typeof CHAPTER_STUBS) {
  return {
    id: "asurascans" as const,
    matchHost: vi.fn().mockReturnValue(true),
    domainAliases: vi.fn().mockReturnValue([]),
    resolveSeries: vi.fn().mockResolvedValue({
      seriesTitle: "Test Series",
      coverUrl: "https://example.com/cover.webp",
      coverReferer: "https://example.com",
      preEnumeratedChapters: CHAPTER_STUBS,
    }),
    enumerateChapters: vi.fn().mockResolvedValue(extraChapters ?? CHAPTER_STUBS),
    parseChapterImages: vi.fn(),
    imageRefererFor: vi.fn().mockReturnValue("https://example.com/ch/1"),
    dismissNsfwSplash: vi.fn(),
    liveDomain: vi.fn().mockReturnValue("example.com"),
  };
}

function makeStore() {
  const chapters: Array<{ chapter_number: number; state: string }> = [];
  return {
    cookies: {} as any,
    runs: {
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      findResumable: vi.fn().mockReturnValue(undefined),
    },
    chapters: {
      byRun: vi.fn().mockReturnValue(chapters),
      upsert: vi.fn(),
      markStatus: vi.fn(),
    },
    pages: {
      byChapter: vi.fn().mockReturnValue([]),
      upsert: vi.fn(),
      markStatus: vi.fn(),
    },
    hashes: { has: vi.fn().mockReturnValue(false), put: vi.fn() },
    close: vi.fn(),
  };
}

function makeHttp(coverStatusCode = 404) {
  return {
    get: vi.fn().mockResolvedValue({ statusCode: 200, body: "html", headers: {} }),
    getImage: vi.fn().mockResolvedValue({ statusCode: coverStatusCode, body: Buffer.alloc(0), headers: {} }),
    isCloudflareChallenged: vi.fn().mockReturnValue(false),
    post: vi.fn().mockResolvedValue({ statusCode: 200, body: "", headers: {} }),
  };
}

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    seriesUrl: "https://asuracomic.net/series/test",
    from: 1,
    to: "latest",
    chapters: null,
    out: "/tmp/test-out",
    format: "webp",
    concurrency: 1,
    resume: false,
    refreshCover: false,
    allowPartialZip: false,
    flaresolverrUrl: null,
    headful: false,
    cookiesFrom: null,
    log: "json",
    dryRun: false,
    allowHeadedCloudflare: false,
    ...overrides,
  };
}

function makeDeps(storeOverride?: ReturnType<typeof makeStore>, httpOverride?: ReturnType<typeof makeHttp>): PipelineDeps {
  const eventBus = new EventBus();
  const store = storeOverride ?? makeStore();
  const http = httpOverride ?? makeHttp();

  return {
    store: store as unknown as PipelineDeps["store"],
    http: http as unknown as PipelineDeps["http"],
    throttler: {
      pauseHost: vi.fn(),
      resumeHost: vi.fn(),
      scheduleForHost: vi.fn((_, fn) => fn()),
      scheduleForImageHost: vi.fn((_, fn) => fn()),
      withCfMutex: vi.fn((_, fn) => fn()),
      adjustConcurrency: vi.fn(),
    } as unknown as PipelineDeps["throttler"],
    jar: {} as unknown as PipelineDeps["jar"],
    browser: { close: vi.fn() } as unknown as PipelineDeps["browser"],
    cf: {} as unknown as PipelineDeps["cf"],
    eventBus,
    ctx: {
      http: http as unknown as any,
      browser: {} as any,
      cookies: {} as any,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      throttle: {} as any,
      signal: new AbortController().signal,
    } as unknown as PipelineDeps["ctx"],
  };
}

describe("Pipeline", () => {
  beforeEach(() => {
    mockRunChapter.mockReset();
    mockAdapterRegistry.matchUrl.mockReset();
    mockRunChapter.mockResolvedValue({ status: "completed", pageCount: 5 });
  });

  describe("happy path", () => {
    it("returns completed status on success", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      const signal = new AbortController().signal;
      const config = makeConfig();

      const result = await pipeline.run(config, signal);

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(ExitCode.SUCCESS);
      expect(result.chaptersCompleted).toBe(3);
      expect(result.chaptersFailed).toHaveLength(0);
      expect(result.outputPath).toMatch(/\.zip$/);
    });

    it("fires run.init event", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const events: string[] = [];
      deps.eventBus.on((e) => events.push(e.type));

      const pipeline = new Pipeline(deps);
      await pipeline.run(makeConfig(), new AbortController().signal);

      expect(events).toContain("run.init");
    });

    it("fires run.done event", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const events: string[] = [];
      deps.eventBus.on((e) => events.push(e.type));

      const pipeline = new Pipeline(deps);
      await pipeline.run(makeConfig(), new AbortController().signal);

      expect(events).toContain("run.done");
    });

    it("emits source.probe events whose host fields match state identifiers in §4 order", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const stateProbes: string[] = [];
      deps.eventBus.on((e) => {
        if (e.type === "source.probe" && (e.payload as { status: number }).status === 0) {
          stateProbes.push((e.payload as { host: string }).host);
        }
      });

      const pipeline = new Pipeline(deps);
      await pipeline.run(makeConfig(), new AbortController().signal);

      const EXPECTED_STATES = [
        "INIT",
        "RESOLVE_SOURCE",
        "RESOLVE_SERIES",
        "ENUMERATE_CHAPTERS",
        "SELECT_RANGE",
        "DOWNLOAD_CHAPTERS",
        "PACKAGE_ZIP",
        "DONE",
      ];

      for (const state of EXPECTED_STATES) {
        expect(stateProbes).toContain(state);
      }

      const firstIdx = (s: string) => stateProbes.indexOf(s);
      for (let i = 0; i < EXPECTED_STATES.length - 1; i++) {
        const curr = EXPECTED_STATES[i]!;
        const next = EXPECTED_STATES[i + 1]!;
        expect(firstIdx(curr)).toBeLessThan(firstIdx(next));
      }
    });

    it("calls runChapter for each selected chapter", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);

      await pipeline.run(makeConfig({ from: 1, to: 2 }), new AbortController().signal);

      expect(mockRunChapter).toHaveBeenCalledTimes(2);
    });
  });

  describe("source not found", () => {
    it("returns failed with SOURCE_NOT_FOUND exit code when no adapter matches", async () => {
      mockAdapterRegistry.matchUrl.mockReturnValue(null);

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      const result = await pipeline.run(makeConfig(), new AbortController().signal);

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(ExitCode.SOURCE_NOT_FOUND);
    });
  });

  describe("allowPartialZip = false, 1 failed chapter", () => {
    it("returns partial status with PARTIAL_RESUME_POSSIBLE exit code and does not build ZIP", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      mockRunChapter.mockResolvedValueOnce({ status: "completed", pageCount: 5 });
      mockRunChapter.mockResolvedValueOnce({
        status: "failed",
        pageCount: 0,
        error: { chapterNumber: 2, code: "ERR_CHAPTER_404", reason: "404" },
      });
      mockRunChapter.mockResolvedValueOnce({ status: "completed", pageCount: 5 });

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      const result = await pipeline.run(makeConfig({ allowPartialZip: false }), new AbortController().signal);

      expect(result.status).toBe("partial");
      expect(result.exitCode).toBe(ExitCode.PARTIAL_RESUME_POSSIBLE);
      expect(result.outputPath).toBeUndefined();
      expect(result.chaptersFailed).toHaveLength(1);
      expect(result.chaptersFailed[0]?.chapterNumber).toBe(2);
    });
  });

  describe("allowPartialZip = true, 1 failed chapter", () => {
    it("builds ZIP with completed chapters and returns partial status", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      mockRunChapter.mockResolvedValueOnce({ status: "completed", pageCount: 5 });
      mockRunChapter.mockResolvedValueOnce({
        status: "failed",
        pageCount: 0,
        error: { chapterNumber: 2, code: "ERR_CHAPTER_404", reason: "404" },
      });
      mockRunChapter.mockResolvedValueOnce({ status: "completed", pageCount: 5 });

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      const result = await pipeline.run(
        makeConfig({ allowPartialZip: true }),
        new AbortController().signal,
      );

      expect(result.outputPath).toMatch(/\.zip$/);
      expect(result.chaptersFailed).toHaveLength(1);
      expect(result.chaptersCompleted).toBe(2);
    });
  });

  describe("dry run", () => {
    it("does not call runChapter in dry-run mode", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      await pipeline.run(makeConfig({ dryRun: true }), new AbortController().signal);

      expect(mockRunChapter).not.toHaveBeenCalled();
    });
  });

  describe("empty range", () => {
    it("returns failed with CONFIG_ERROR exit code when from > all available chapters", async () => {
      const adapter = makeAdapter();
      mockAdapterRegistry.matchUrl.mockReturnValue(adapter);

      const deps = makeDeps();
      const pipeline = new Pipeline(deps);
      const result = await pipeline.run(makeConfig({ from: 9999, to: "latest" }), new AbortController().signal);

      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
    });
  });
});
