/**
 * Integration test: produced ZIP must pass the PWA importer.
 *
 * Steps:
 *  1. Build a staging tree with synthetic 8x8 PNG pages.
 *  2. Run the packager.
 *  3. Load the produced ZIP via JSZip.
 *  4. Call walkSeries (via importerProxy — see test/lib/importerProxy.ts for
 *     why we use a proxy rather than importing the app source directly).
 *  5. Assert SeriesEntry shape: title, chapter count, page order.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import JSZip from "jszip";
import { makeTmpDir } from "./setup.js";
import { StagingDir } from "../src/packaging/staging.js";
import { Packager } from "../src/packaging/packager.js";
import { EventBus } from "../src/core/events.js";
import {
  walkSeries,
  getTopLevelFolders,
  type SeriesEntry,
} from "./lib/importerProxy.js";

// ---------------------------------------------------------------------------
// Tiny PNG builder (same approach as app/scripts/build-fixture.mjs)
// ---------------------------------------------------------------------------

function makePng(width = 8, height = 8, tone = 128): Buffer {
  const { crc32 } = require("node:zlib") as typeof import("zlib");
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
      raw[i + 2] = (tone + (x + y)) & 0xff;
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
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("integration: packager ZIP vs PWA importer (walkSeries)", () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // Main integration scenario: 2 chapters, 3 pages each, 1 cover
  // -------------------------------------------------------------------------

  it("produced ZIP passes walkSeries with correct title, chapter count, and page order", async () => {
    const SERIES_TITLE = "Solo Leveling";
    const CHAPTER_COUNT = 2;
    const PAGES_PER_CHAPTER = 3;

    // 1. Build staging tree
    const staging = new StagingDir(tmpDir, "integration-run-1");
    await staging.init();
    await staging.writeCover(makePng(16, 24, 80), "image/png");
    for (let c = 1; c <= CHAPTER_COUNT; c++) {
      for (let p = 1; p <= PAGES_PER_CHAPTER; p++) {
        await staging.writePage(
          c,
          p,
          makePng(8, 8, (c * 10 + p * 5) & 0xff),
          "image/png",
        );
      }
    }

    // 2. Run packager
    const bus = new EventBus();
    const packager = new Packager(bus);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: SERIES_TITLE,
      allowPartial: true,
    });

    // 3. Load ZIP via JSZip
    const zipBuf = await readFile(result.path);
    const jszip = await JSZip.loadAsync(zipBuf);

    // 4. Discover the series folder and call walkSeries
    const topFolders = getTopLevelFolders(jszip);
    expect(topFolders).toHaveLength(1);
    const seriesFolder = topFolders[0]!;

    // KEY ASSERTION: walkSeries must parse the ZIP without modification
    const series: SeriesEntry = await walkSeries(jszip, seriesFolder);

    // 5. Assert SeriesEntry shape

    // 5a. Title matches the sanitized series title
    expect(series.title).toBe(SERIES_TITLE);

    // 5b. Cover is present
    expect(series.coverPath).not.toBeNull();
    expect(series.coverPath).toMatch(/\/cover\.(webp|jpg|jpeg|png)$/i);

    // 5c. Chapter count matches
    expect(series.chapters).toHaveLength(CHAPTER_COUNT);

    // 5d. Chapters are in ascending order
    for (let i = 0; i < series.chapters.length; i++) {
      expect(series.chapters[i]!.order).toBe(i + 1);
    }

    // 5e. Each chapter has the correct number of pages
    for (const chapter of series.chapters) {
      expect(chapter.pages).toHaveLength(PAGES_PER_CHAPTER);
    }

    // 5f. Pages within each chapter are in ascending pageNumber order starting at 1
    for (const chapter of series.chapters) {
      for (let p = 0; p < chapter.pages.length; p++) {
        expect(chapter.pages[p]!.pageNumber).toBe(p + 1);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Decimal chapter (e.g. Chapter 001.5)
  // -------------------------------------------------------------------------

  it("decimal chapter order is preserved through walkSeries", async () => {
    const staging = new StagingDir(tmpDir, "integration-run-2");
    await staging.init();

    // Write chapter 1 and chapter 1.5
    await staging.writePage(1, 1, makePng(), "image/png");
    await staging.writePage(1.5, 1, makePng(), "image/png");

    const bus = new EventBus();
    const packager = new Packager(bus);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Decimal Test",
      allowPartial: true,
    });

    const jszip = await JSZip.loadAsync(await readFile(result.path));
    const folders = getTopLevelFolders(jszip);
    const series = await walkSeries(jszip, folders[0]!);

    expect(series.chapters).toHaveLength(2);
    // Sorted by extractSortKey: 1 < 1.5
    expect(series.chapters[0]!.order).toBe(1);
    expect(series.chapters[1]!.order).toBe(1.5);
  });

  // -------------------------------------------------------------------------
  // Series title with special characters is sanitized in ZIP folder name
  // -------------------------------------------------------------------------

  it("series title with illegal chars is sanitized in ZIP and walkSeries reads the sanitized title", async () => {
    const RAW_TITLE = "Tower: of God";
    const EXPECTED_FOLDER_TITLE = "Tower_ of God"; // colon → underscore

    const staging = new StagingDir(tmpDir, "integration-run-3");
    await staging.init();
    await staging.writePage(1, 1, makePng(), "image/png");

    const bus = new EventBus();
    const packager = new Packager(bus);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: RAW_TITLE,
      allowPartial: true,
    });

    const jszip = await JSZip.loadAsync(await readFile(result.path));
    const folders = getTopLevelFolders(jszip);
    expect(folders[0]).toBe(`${EXPECTED_FOLDER_TITLE}/`);

    const series = await walkSeries(jszip, folders[0]!);
    expect(series.title).toBe(EXPECTED_FOLDER_TITLE);
  });

  // -------------------------------------------------------------------------
  // Multiple chapters, more pages — verify full page-number sequence
  // -------------------------------------------------------------------------

  it("10 chapters × 5 pages: all pages have pageNumber 1..5 in each chapter", async () => {
    const staging = new StagingDir(tmpDir, "integration-run-4");
    await staging.init();
    await staging.writeCover(makePng(16, 24, 100), "image/png");

    const CHAPTERS = 10;
    const PAGES = 5;
    for (let c = 1; c <= CHAPTERS; c++) {
      for (let p = 1; p <= PAGES; p++) {
        await staging.writePage(c, p, makePng(8, 8, (c * 7 + p * 3) & 0xff), "image/png");
      }
    }

    const bus = new EventBus();
    const packager = new Packager(bus);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Big Series",
      allowPartial: true,
    });

    const jszip = await JSZip.loadAsync(await readFile(result.path));
    const series = await walkSeries(jszip, getTopLevelFolders(jszip)[0]!);

    expect(series.chapters).toHaveLength(CHAPTERS);
    for (const ch of series.chapters) {
      expect(ch.pages).toHaveLength(PAGES);
      const pageNums = ch.pages.map((p) => p.pageNumber);
      expect(pageNums).toEqual([1, 2, 3, 4, 5]);
    }
  });

  // -------------------------------------------------------------------------
  // No cover → importer gracefully handles missing coverPath
  // -------------------------------------------------------------------------

  it("ZIP with no cover has coverPath=null in walkSeries result", async () => {
    const staging = new StagingDir(tmpDir, "integration-run-5");
    await staging.init();
    await staging.writePage(1, 1, makePng(), "image/png");

    const bus = new EventBus();
    const packager = new Packager(bus);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "NoCoverSeries",
      allowPartial: true,
    });

    const jszip = await JSZip.loadAsync(await readFile(result.path));
    const series = await walkSeries(jszip, getTopLevelFolders(jszip)[0]!);

    expect(series.coverPath).toBeNull();
    expect(series.chapters).toHaveLength(1);
  });
});
