/**
 * cli.program.test.ts — Commander flag parsing and validation.
 *
 * All I/O that touches the filesystem (mkdir, access) and the pipeline are
 * mocked so tests are fast and hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before imports)
// ---------------------------------------------------------------------------

vi.mock("../src/adapters/index.js", () => ({
  adapterRegistry: {
    matchUrl: vi.fn(),
    byId: vi.fn(),
  },
}));

vi.mock("../src/core/runContext.js", () => ({
  buildRunContext: vi.fn(),
}));

vi.mock("../src/core/pipeline.js", () => ({
  Pipeline: vi.fn(),
}));

vi.mock("../src/core/events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/events.js")>();
  return {
    ...actual,
    createPinoSink: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Deferred imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { runCli } from "../src/cli/program.js";
import { adapterRegistry } from "../src/adapters/index.js";
import { buildRunContext } from "../src/core/runContext.js";
import { Pipeline } from "../src/core/pipeline.js";
import { EventBus } from "../src/core/events.js";
import { ExitCode } from "../src/core/types.js";

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const mockMatchUrl = adapterRegistry.matchUrl as ReturnType<typeof vi.fn>;
const mockBuildRunContext = buildRunContext as ReturnType<typeof vi.fn>;
const MockPipeline = Pipeline as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

function makeFakeAdapter() {
  return {
    id: "asurascans" as const,
    matchHost: vi.fn().mockReturnValue(true),
    domainAliases: vi.fn().mockReturnValue([]),
    resolveSeries: vi.fn(),
    enumerateChapters: vi.fn(),
    parseChapterImages: vi.fn(),
    imageRefererFor: vi.fn(),
    dismissNsfwSplash: vi.fn(),
    liveDomain: vi.fn().mockReturnValue("asuracomic.net"),
  };
}

// ---------------------------------------------------------------------------
// Fake context
// ---------------------------------------------------------------------------

function makeFakeContext() {
  const eventBus = new EventBus();
  return {
    ctx: {},
    http: {},
    browser: { close: vi.fn() },
    jar: {},
    store: { close: vi.fn(), runs: { create: vi.fn(), update: vi.fn() } },
    throttler: {},
    cf: {},
    eventBus,
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "verreaux-prog-test-"));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mockPipelineSuccess(overrides: Partial<{
  status: string;
  exitCode: number;
  chaptersCompleted: number;
  chaptersFailed: unknown[];
  outputPath: string;
  durationMs: number;
}> = {}) {
  const result = {
    runId: "test-run-id",
    status: "completed",
    chaptersCompleted: 3,
    chaptersFailed: [],
    outputPath: join(tmpDir, "output.zip"),
    durationMs: 1234,
    exitCode: ExitCode.SUCCESS,
    ...overrides,
  };
  MockPipeline.mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(result),
  }));
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCli — happy path", () => {
  it("parses full arg vector and produces correct RunConfig fields", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const fakeCtx = makeFakeContext();
    mockBuildRunContext.mockResolvedValue(fakeCtx);

    let capturedConfig: unknown;
    MockPipeline.mockImplementation(() => ({
      run: vi.fn().mockImplementation((config: unknown) => {
        capturedConfig = config;
        return Promise.resolve({
          runId: "r1",
          status: "completed",
          chaptersCompleted: 2,
          chaptersFailed: [],
          outputPath: join(tmpDir, "out.zip"),
          durationMs: 500,
          exitCode: ExitCode.SUCCESS,
        });
      }),
    }));

    const code = await runCli([
      "node",
      "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--from", "5",
      "--to", "10",
      "--out", tmpDir,
      "--format", "webp",
      "--concurrency", "2",
      "--log-format", "json",
    ]);

    expect(code).toBe(ExitCode.SUCCESS);

    const config = capturedConfig as Record<string, unknown>;
    expect(config["seriesUrl"]).toBe("https://asuracomic.net/series/test-abc123");
    expect(config["from"]).toBe(5);
    expect(config["to"]).toBe(10);
    expect(config["format"]).toBe("webp");
    expect(config["concurrency"]).toBe(2);
  });

  it("--to latest resolves to the string sentinel 'latest'", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const fakeCtx = makeFakeContext();
    mockBuildRunContext.mockResolvedValue(fakeCtx);

    let capturedConfig: unknown;
    MockPipeline.mockImplementation(() => ({
      run: vi.fn().mockImplementation((config: unknown) => {
        capturedConfig = config;
        return Promise.resolve({
          runId: "r2",
          status: "completed",
          chaptersCompleted: 1,
          chaptersFailed: [],
          outputPath: join(tmpDir, "out.zip"),
          durationMs: 100,
          exitCode: ExitCode.SUCCESS,
        });
      }),
    }));

    const code = await runCli([
      "node",
      "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--to", "latest",
      "--out", tmpDir,
    ]);

    expect(code).toBe(ExitCode.SUCCESS);
    const config = capturedConfig as Record<string, unknown>;
    expect(config["to"]).toBe("latest");
  });
});

describe("runCli — validation failures", () => {
  it("missing series-url → exit 2", async () => {
    const code = await runCli(["node", "verreaux-scrape"]);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it("malformed URL → exit 2", async () => {
    const code = await runCli(["node", "verreaux-scrape", "not-a-url"]);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it("--from > --to → exit 2 with clear message", async () => {
    // We need a valid URL that matches an adapter, then fail on range
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    try {
      const code = await runCli([
        "node", "verreaux-scrape",
        "https://asuracomic.net/series/test-abc123",
        "--from", "10",
        "--to", "5",
        "--out", tmpDir,
      ]);

      expect(code).toBe(ExitCode.CONFIG_ERROR);
      expect(stderrWrites.join("")).toContain("10");
      expect(stderrWrites.join("")).toContain("5");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("unknown host → exit 4 with supported-host list", async () => {
    mockMatchUrl.mockReturnValue(null);
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    try {
      const code = await runCli([
        "node", "verreaux-scrape",
        "https://unknown-site.com/series/whatever",
        "--out", tmpDir,
      ]);

      expect(code).toBe(ExitCode.SOURCE_NOT_FOUND);
      const combined = stderrWrites.join("");
      expect(combined).toContain("unknown-site.com");
      // Should list supported hosts
      expect(combined).toMatch(/asuracomic|manhuaplus/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("--concurrency 5 → exit 2 (out of range [1,3])", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--concurrency", "5",
      "--out", tmpDir,
    ]);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it("--concurrency 0 → exit 2 (below range)", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--concurrency", "0",
      "--out", tmpDir,
    ]);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it("--format invalid → exit 2", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--format", "bmp",
      "--out", tmpDir,
    ]);
    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });
});

describe("runCli — pipeline result propagation", () => {
  it("returns the pipeline's exit code on partial result", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    mockBuildRunContext.mockResolvedValue(makeFakeContext());
    mockPipelineSuccess({
      status: "partial",
      exitCode: ExitCode.PARTIAL_RESUME_POSSIBLE,
    });

    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--out", tmpDir,
    ]);

    expect(code).toBe(ExitCode.PARTIAL_RESUME_POSSIBLE);
  });

  it("exits PARTIAL_RESUME_POSSIBLE when the pipeline returns rateLimited (zip on disk)", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    mockBuildRunContext.mockResolvedValue(makeFakeContext());
    mockPipelineSuccess({
      status: "partial",
      exitCode: ExitCode.PARTIAL_RESUME_POSSIBLE,
      // Cast-through: rateLimited is present on the real PipelineResult.
      ...( { rateLimited: true } as Record<string, unknown> ),
    });

    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--out", tmpDir,
    ]);

    expect(code).toBe(ExitCode.PARTIAL_RESUME_POSSIBLE);
  });

  it("maps thrown errors via errorMap and returns correct exit code", async () => {
    mockMatchUrl.mockReturnValue(makeFakeAdapter());
    mockBuildRunContext.mockResolvedValue(makeFakeContext());
    MockPipeline.mockImplementation(() => ({
      run: vi.fn().mockRejectedValue(new Error("unexpected boom")),
    }));

    const code = await runCli([
      "node", "verreaux-scrape",
      "https://asuracomic.net/series/test-abc123",
      "--out", tmpDir,
    ]);

    expect(code).toBe(ExitCode.GENERIC);
  });
});
