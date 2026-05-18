/**
 * cli.e2e.test.ts — Minimal end-to-end test with all I/O mocked.
 *
 * Strategy:
 *  - Mock adapterRegistry to return a fake adapter yielding 2 chapters,
 *    3 synthetic PNG pages each.
 *  - Mock buildRunContext to return a lightweight in-memory context.
 *  - Let the real Pipeline run (not mocked) so the packaging path executes.
 *  - Assert: exit code 0, ZIP file exists at expected path, ZIP passes walkSeries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the mocked modules
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
// Deferred imports
// ---------------------------------------------------------------------------

import { runCli } from "../src/cli/program.js";
import { adapterRegistry } from "../src/adapters/index.js";
import { buildRunContext } from "../src/core/runContext.js";
import { EventBus } from "../src/core/events.js";
import { ExitCode } from "../src/core/types.js";
import { openStore } from "../src/state/store.js";
import { walkSeries, getTopLevelFolders } from "./lib/importerProxy.js";

// ---------------------------------------------------------------------------
// PNG builder (minimal valid PNG, same as integration test)
// ---------------------------------------------------------------------------

function makePng(tone = 128): Buffer {
  const { crc32 } = require("node:zlib") as typeof import("zlib");
  const width = 8;
  const height = 8;
  const channels = 4;
  const rowBytes = width * channels;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + rowBytes);
    raw[off] = 0;
    for (let x = 0; x < width; x++) {
      const i = off + 1 + x * 4;
      raw[i] = (tone + x * 3) & 0xff;
      raw[i + 1] = (tone + y * 5) & 0xff;
      raw[i + 2] = (tone + x + y) & 0xff;
      raw[i + 3] = 255;
    }
  }
  const idatData = deflateRawSync(raw);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcInput = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc32(crcInput) as unknown as number) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Fake adapter: 2 chapters, 3 PNG pages each
// ---------------------------------------------------------------------------

const SERIES_TITLE = "test";
const CHAPTERS = 2;
const PAGES_PER_CHAPTER = 3;

function makeFakeAdapter() {
  return {
    id: "asurascans" as const,
    matchHost: vi.fn().mockReturnValue(true),
    domainAliases: vi.fn().mockReturnValue([]),
    liveDomain: vi.fn().mockReturnValue("asurascans.com"),
    dismissNsfwSplash: vi.fn().mockResolvedValue(undefined),
    imageRefererFor: vi.fn().mockReturnValue("https://asurascans.com/"),

    resolveSeries: vi.fn().mockResolvedValue({
      seriesTitle: SERIES_TITLE,
      coverUrl: "https://asurascans.com/cover.png",
      coverReferer: "https://asurascans.com/",
      preEnumeratedChapters: [
        { chapterNumber: 1, chapterTitle: "Chapter 1", chapterUrl: "https://asurascans.com/chapters/1" },
        { chapterNumber: 2, chapterTitle: "Chapter 2", chapterUrl: "https://asurascans.com/chapters/2" },
      ],
    }),

    enumerateChapters: vi.fn().mockResolvedValue([
      { chapterNumber: 1, chapterTitle: "Chapter 1", chapterUrl: "https://asurascans.com/chapters/1" },
      { chapterNumber: 2, chapterTitle: "Chapter 2", chapterUrl: "https://asurascans.com/chapters/2" },
    ]),

    parseChapterImages: vi.fn().mockImplementation(
      (_ctx: unknown, chapter: { chapterNumber: number }) => {
        const pages = [];
        for (let p = 1; p <= PAGES_PER_CHAPTER; p++) {
          pages.push({
            pageIndex: p,
            imageUrl: `https://cdn.asurascans.com/ch${chapter.chapterNumber}/page${p}.png`,
            referer: `https://asurascans.com/chapters/${chapter.chapterNumber}`,
          });
        }
        return Promise.resolve(pages);
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Build an in-memory RunContext using a real sqlite :memory: store
// ---------------------------------------------------------------------------

function makeInMemoryContext(outDir: string) {
  const eventBus = new EventBus();
  const store = openStore(":memory:");

  // HTTP client: returns HTML for chapter pages, PNG buffers for images
  const http = {
    get: vi.fn().mockResolvedValue({
      statusCode: 200,
      body: "<html>chapter</html>",
      headers: {},
    }),
    getImage: vi.fn().mockImplementation((url: string) => {
      // Serve a valid PNG for every image URL
      const tone = url.includes("page1") ? 80 : url.includes("page2") ? 120 : 160;
      return Promise.resolve({
        statusCode: 200,
        body: makePng(tone),
        headers: { "content-type": "image/png" },
      });
    }),
    isCloudflareChallenged: vi.fn().mockReturnValue(false),
    post: vi.fn().mockResolvedValue({ statusCode: 200, body: "", headers: {} }),
  };

  const throttler = {
    pauseHost: vi.fn(),
    resumeHost: vi.fn(),
    scheduleForHost: vi.fn((_host: string, fn: () => Promise<unknown>) => fn()),
    scheduleForImageHost: vi.fn((_host: string, fn: () => Promise<unknown>) => fn()),
    withCfMutex: vi.fn((_host: string, fn: () => Promise<unknown>) => fn()),
    adjustConcurrency: vi.fn(),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const ctx = {
    http,
    browser: { close: vi.fn() },
    cookies: {},
    logger,
    throttle: throttler,
    signal: new AbortController().signal,
  };

  return {
    ctx,
    http,
    browser: { close: vi.fn() },
    jar: {},
    store,
    throttler,
    cf: {},
    eventBus,
    cleanup: vi.fn().mockImplementation(async () => {
      try { store.close(); } catch { /* ignore */ }
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cli e2e — runCli with mocked transport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "verreaux-e2e-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exits 0, produces a ZIP that passes walkSeries", async () => {
    const fakeAdapter = makeFakeAdapter();
    const fakeCtx = makeInMemoryContext(tmpDir);

    (adapterRegistry.matchUrl as ReturnType<typeof vi.fn>).mockReturnValue(fakeAdapter);
    (buildRunContext as ReturnType<typeof vi.fn>).mockResolvedValue(fakeCtx);

    const code = await runCli([
      "node",
      "verreaux-scrape",
      "https://asurascans.com/comics/test-abc123",
      "--out", tmpDir,
      "--to", "2",
      "--log-format", "json",
    ]);

    expect(code).toBe(ExitCode.SUCCESS);

    // Find the ZIP file in tmpDir
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".zip"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const zipPath = join(tmpDir, files[0]!);
    const zipBuf = await readFile(zipPath);
    const jszip = await JSZip.loadAsync(zipBuf);

    const topFolders = getTopLevelFolders(jszip);
    expect(topFolders).toHaveLength(1);

    const series = await walkSeries(jszip, topFolders[0]!);

    // Title should match the sanitized series title
    expect(series.title.toLowerCase()).toContain("test");

    // Both chapters should be present
    expect(series.chapters).toHaveLength(CHAPTERS);

    // Each chapter should have 3 pages
    for (const chapter of series.chapters) {
      expect(chapter.pages).toHaveLength(PAGES_PER_CHAPTER);
    }
  });
});
