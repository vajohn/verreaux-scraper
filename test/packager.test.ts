import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { makeTmpDir } from "./setup.js";
import { StagingDir } from "../src/packaging/staging.js";
import { Packager, PackageIncompletenessError } from "../src/packaging/packager.js";
import { EventBus } from "../src/core/events.js";

// ---------------------------------------------------------------------------
// Helpers
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

/** Build a staging tree with N chapters, P pages each and a cover. */
async function buildStaging(
  outDir: string,
  runId: string,
  chapterCount: number,
  pagesPerChapter: number,
): Promise<StagingDir> {
  const staging = new StagingDir(outDir, runId);
  await staging.init();
  await staging.writeCover(makePng(16, 24, 80), "image/png");
  for (let c = 1; c <= chapterCount; c++) {
    for (let p = 1; p <= pagesPerChapter; p++) {
      await staging.writePage(c, p, makePng(8, 8, (c * 10 + p * 5) & 0xff), "image/png");
    }
  }
  return staging;
}

/** Read the Local File Header compression method for the entry at offset 0 in the ZIP buffer. */
function readLfhCompressionMethod(zipBuf: Buffer, entryOffset: number): number {
  // Local file header structure:
  //   offset 0: signature (4 bytes) — 0x04034b50
  //   offset 4: version needed (2)
  //   offset 6: general purpose bit flag (2)
  //   offset 8: compression method (2) ← this is what we want
  return zipBuf.readUInt16LE(entryOffset + 8);
}

/**
 * Minimal central-directory parser to get all (entryName, compressionMethod)
 * pairs from a ZIP buffer.
 */
function parseZipEntries(
  zipBuf: Buffer,
): Array<{ name: string; compressionMethod: number; localHeaderOffset: number }> {
  // Find end-of-central-directory (EOCD) record: signature 0x06054b50
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found");

  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  const cdSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const entries: Array<{ name: string; compressionMethod: number; localHeaderOffset: number }> = [];

  let pos = cdOffset;
  const CD_SIG = 0x02014b50;
  while (pos < cdOffset + cdSize) {
    if (zipBuf.readUInt32LE(pos) !== CD_SIG) break;
    const compressionMethod = zipBuf.readUInt16LE(pos + 10);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.push({ name, compressionMethod, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Packager", () => {
  let tmpDir: string;
  let cleanup: () => void;
  let bus: EventBus;
  let packager: Packager;

  beforeEach(() => {
    ({ dir: tmpDir, cleanup } = makeTmpDir());
    bus = new EventBus();
    packager = new Packager(bus);
  });

  afterEach(() => cleanup());

  // -------------------------------------------------------------------------
  // Basic build
  // -------------------------------------------------------------------------

  it("builds a ZIP and returns the correct path", async () => {
    const staging = await buildStaging(tmpDir, "run-001", 2, 3);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Solo Leveling",
      allowPartial: true,
    });
    expect(existsSync(result.path)).toBe(true);
    expect(result.path.endsWith(".zip")).toBe(true);
  });

  it("returns correct chapterCount and pageCount", async () => {
    const staging = await buildStaging(tmpDir, "run-002", 3, 5);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Tower of God",
      allowPartial: true,
    });
    expect(result.chapterCount).toBe(3);
    expect(result.pageCount).toBe(15);
  });

  it("returns positive byteLength", async () => {
    const staging = await buildStaging(tmpDir, "run-003", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test Series",
      allowPartial: true,
    });
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it("writes the ZIP to the final path (not tmp path)", async () => {
    const staging = await buildStaging(tmpDir, "run-004", 1, 1);
    const outPath = join(tmpDir, "my-output");
    await packager.build(staging, {
      outPath,
      seriesTitle: "Test",
      allowPartial: true,
    });
    expect(existsSync(`${outPath}.zip`)).toBe(true);
    // Tmp file must be gone
    expect(existsSync(`${outPath}.zip.tmp`)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ZIP structure
  // -------------------------------------------------------------------------

  it("uses the sanitized series title as the top-level ZIP folder", async () => {
    const staging = await buildStaging(tmpDir, "run-005", 1, 1);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: 'Series: "With Quotes"',
      allowPartial: true,
    });

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(result.path);
    const entries = zip.getEntries().map((e) => e.entryName);
    // All entries should start with the sanitized folder name
    expect(entries.every((e) => e.startsWith("Series_ _With Quotes_/"))).toBe(
      true,
    );
  });

  it("includes a cover entry in the ZIP", async () => {
    const staging = await buildStaging(tmpDir, "run-006", 1, 1);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test",
      allowPartial: true,
    });

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(result.path);
    const hasCover = zip.getEntries().some((e) => /\/cover\.(png|jpg|jpeg|webp)$/.test(e.entryName));
    expect(hasCover).toBe(true);
  });

  it("includes all page entries in the ZIP", async () => {
    const staging = await buildStaging(tmpDir, "run-007", 2, 3);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test",
      allowPartial: true,
    });

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(result.path);
    const pageEntries = zip.getEntries().filter((e) =>
      /\/Chapter \d+\/\d+\.\w+$/.test(e.entryName),
    );
    expect(pageEntries).toHaveLength(6); // 2 chapters × 3 pages
  });

  // -------------------------------------------------------------------------
  // Compression method: pages MUST be STORED (method = 0)
  // -------------------------------------------------------------------------

  it("page entries have compression method STORED (0) in the central directory", async () => {
    const staging = await buildStaging(tmpDir, "run-008", 2, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test",
      allowPartial: true,
    });

    const zipBuf = await import("node:fs/promises").then((m) =>
      m.readFile(result.path),
    );
    const cdEntries = parseZipEntries(zipBuf);
    const pageEntries = cdEntries.filter((e) =>
      /\/Chapter \d+\/\d+\.\w+$/.test(e.name),
    );
    expect(pageEntries.length).toBeGreaterThan(0);
    for (const entry of pageEntries) {
      expect(entry.compressionMethod).toBe(0); // STORED
    }
  });

  it("page entries have compression method STORED (0) in their Local File Headers", async () => {
    const staging = await buildStaging(tmpDir, "run-009", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test",
      allowPartial: true,
    });

    const zipBuf = await import("node:fs/promises").then((m) =>
      m.readFile(result.path),
    );
    const cdEntries = parseZipEntries(zipBuf);
    const pageEntries = cdEntries.filter((e) =>
      /\/Chapter \d+\/\d+\.\w+$/.test(e.name),
    );
    for (const entry of pageEntries) {
      const lfhMethod = readLfhCompressionMethod(zipBuf, entry.localHeaderOffset);
      expect(lfhMethod).toBe(0); // STORED
    }
  });

  // -------------------------------------------------------------------------
  // allowPartial = false with expectedPagesPerChapter
  // -------------------------------------------------------------------------

  it("rejects build when allowPartial=false and a chapter has fewer pages than expected", async () => {
    // Build 2 chapters with only 2 pages each, but claim we expected 3
    const staging = await buildStaging(tmpDir, "run-010", 2, 2);
    const expected = new Map<number, number>([
      [1, 3], // chapter 1 expected 3 pages, only has 2
      [2, 2],
    ]);

    await expect(
      packager.build(staging, {
        outPath: join(tmpDir, "output"),
        seriesTitle: "Test",
        allowPartial: false,
        expectedPagesPerChapter: expected,
      }),
    ).rejects.toThrow(PackageIncompletenessError);
  });

  it("rejects with PackageIncompletenessError naming the incomplete chapter", async () => {
    const staging = await buildStaging(tmpDir, "run-011", 1, 1);
    const expected = new Map<number, number>([[1, 5]]);

    try {
      await packager.build(staging, {
        outPath: join(tmpDir, "output"),
        seriesTitle: "Test",
        allowPartial: false,
        expectedPagesPerChapter: expected,
      });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PackageIncompletenessError);
      const err = e as PackageIncompletenessError;
      expect(err.chapterName).toContain("Chapter 001");
      expect(err.expected).toBe(5);
      expect(err.actual).toBe(1);
    }
  });

  it("succeeds when allowPartial=false and all chapters have exactly the expected count", async () => {
    const staging = await buildStaging(tmpDir, "run-012", 2, 3);
    const expected = new Map<number, number>([
      [1, 3],
      [2, 3],
    ]);

    await expect(
      packager.build(staging, {
        outPath: join(tmpDir, "output"),
        seriesTitle: "Test",
        allowPartial: false,
        expectedPagesPerChapter: expected,
      }),
    ).resolves.toBeDefined();
  });

  it("succeeds when allowPartial=true even with incomplete chapters vs expected", async () => {
    const staging = await buildStaging(tmpDir, "run-013", 1, 1);
    const expected = new Map<number, number>([[1, 99]]);

    await expect(
      packager.build(staging, {
        outPath: join(tmpDir, "output"),
        seriesTitle: "Test",
        allowPartial: true,
        expectedPagesPerChapter: expected,
      }),
    ).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  it("emits package.started before package.written", async () => {
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const staging = await buildStaging(tmpDir, "run-014", 1, 1);
    await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "Test",
      allowPartial: true,
    });

    expect(events).toContain("package.started");
    expect(events).toContain("package.written");
    expect(events.indexOf("package.started")).toBeLessThan(
      events.indexOf("package.written"),
    );
  });

  it("emits run.fatal and cleans up tmp file on build failure", async () => {
    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    const staging = await buildStaging(tmpDir, "run-015", 1, 1);
    const expected = new Map<number, number>([[1, 99]]);

    await expect(
      packager.build(staging, {
        outPath: join(tmpDir, "output-fail"),
        seriesTitle: "Test",
        allowPartial: false,
        expectedPagesPerChapter: expected,
      }),
    ).rejects.toThrow();

    expect(events).toContain("run.fatal");
    // tmp file must not linger
    expect(existsSync(join(tmpDir, "output-fail.zip.tmp"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Skips cover when none present
  // -------------------------------------------------------------------------

  it("builds successfully with no cover when staging has no cover file", async () => {
    // Create staging without a cover
    const staging = new StagingDir(tmpDir, "run-no-cover");
    await staging.init();
    await staging.writePage(1, 1, makePng(), "image/png");

    const result = await packager.build(staging, {
      outPath: join(tmpDir, "output"),
      seriesTitle: "NoCoverSeries",
      allowPartial: true,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(result.chapterCount).toBe(1);
    expect(result.pageCount).toBe(1);

    const AdmZip = (await import("adm-zip")).default;
    const zip = new AdmZip(result.path);
    const hasCover = zip.getEntries().some((e) => /\/cover\./.test(e.entryName));
    expect(hasCover).toBe(false);
  });

  it("embeds verreaux.json at the ZIP root (DEFLATE) when a manifest is supplied", async () => {
    const staging = await buildStaging(tmpDir, "run-manifest", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "with-manifest"),
      seriesTitle: "Solo Leveling",
      allowPartial: true,
      manifest: {
        schema: 1,
        sourceUrl: "https://qimanhwa.com/series/solo",
        seriesTitle: "Solo Leveling",
        adapter: "qimanhwa",
        chapterRange: { from: 0, to: "latest" },
        generatedAt: "2026-06-16T15:30:12Z",
      },
    });
    const buf = readFileSync(result.path);
    const entries = parseZipEntries(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain("verreaux.json");
    expect(names).not.toContain("Solo Leveling/verreaux.json");
    // The manifest is small JSON, so it is DEFLATE'd (method 8), unlike the
    // STORED (method 0) already-compressed page images.
    expect(entries.find((e) => e.name === "verreaux.json")?.compressionMethod).toBe(8);
  });

  it("omits verreaux.json when no manifest is supplied", async () => {
    const staging = await buildStaging(tmpDir, "run-nomanifest", 1, 2);
    const result = await packager.build(staging, {
      outPath: join(tmpDir, "no-manifest"),
      seriesTitle: "Solo Leveling",
      allowPartial: true,
    });
    const names = parseZipEntries(readFileSync(result.path)).map((e) => e.name);
    expect(names).not.toContain("verreaux.json");
  });
});
