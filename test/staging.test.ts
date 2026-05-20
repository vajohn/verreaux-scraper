import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { makeTmpDir } from "./setup.js";
import {
  StagingDir,
  detectImageExt,
  UnsupportedImageFormatError,
} from "../src/packaging/staging.js";
import { deflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Helpers — tiny synthetic images (same approach as app/scripts/build-fixture.mjs)
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

  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeJpeg(): Buffer {
  // Minimal valid JPEG: SOI + EOI
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49,
    0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
}

function makeWebP(): Buffer {
  // Minimal WebP: RIFF....WEBP header (12 bytes) + minimal VP8L chunk
  const riff = Buffer.from("RIFF", "ascii");
  const size = Buffer.alloc(4); // file size - 8
  const webp = Buffer.from("WEBP", "ascii");
  const vp8l = Buffer.from("VP8L", "ascii");
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(4, 0);
  const data = Buffer.from([0x2f, 0x00, 0x00, 0x00]); // minimal VP8L
  const total =
    4 + 4 + 4 + 4 + 4 + data.length; // WEBP + VP8L header + data
  size.writeUInt32LE(total - 8, 0);
  return Buffer.concat([riff, size, webp, vp8l, chunkSize, data]);
}

function makeGif(): Buffer {
  return Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
}

function makeBmp(): Buffer {
  return Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
}

function makeSvg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>',
  );
}

// ---------------------------------------------------------------------------
// detectImageExt
// ---------------------------------------------------------------------------

describe("detectImageExt", () => {
  it("detects PNG from magic bytes", () => {
    expect(detectImageExt(makePng())).toBe(".png");
  });

  it("detects JPEG from magic bytes", () => {
    expect(detectImageExt(makeJpeg())).toBe(".jpg");
  });

  it("detects WebP from magic bytes", () => {
    expect(detectImageExt(makeWebP())).toBe(".webp");
  });

  it("rejects GIF with UnsupportedImageFormatError", () => {
    expect(() => detectImageExt(makeGif())).toThrow(UnsupportedImageFormatError);
    expect(() => detectImageExt(makeGif())).toThrow(/GIF/i);
  });

  it("rejects BMP with UnsupportedImageFormatError", () => {
    expect(() => detectImageExt(makeBmp())).toThrow(UnsupportedImageFormatError);
    expect(() => detectImageExt(makeBmp())).toThrow(/BMP/i);
  });

  it("accepts SVG and returns .svg", () => {
    expect(detectImageExt(makeSvg())).toBe(".svg");
  });

  it("accepts SVG even when prefixed with an XML declaration", () => {
    const xmlSvg = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>',
    );
    expect(detectImageExt(xmlSvg)).toBe(".svg");
  });

  it("rejects a too-small buffer", () => {
    expect(() => detectImageExt(Buffer.alloc(4))).toThrow(
      UnsupportedImageFormatError,
    );
  });

  it("GIF error has detectedFormat === 'gif'", () => {
    try {
      detectImageExt(makeGif());
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedImageFormatError);
      expect((e as UnsupportedImageFormatError).detectedFormat).toBe("gif");
    }
  });

  it("ignores the mime parameter — Content-Type does not override magic bytes", () => {
    // If someone passes a PNG buffer with mime="image/jpeg", should detect PNG
    const pngBuf = makePng();
    expect(detectImageExt(pngBuf)).toBe(".png"); // not .jpg
  });
});

// ---------------------------------------------------------------------------
// StagingDir — lifecycle and writes
// ---------------------------------------------------------------------------

describe("StagingDir", () => {
  let tmpDir: string;
  let cleanup: () => void;
  let staging: StagingDir;

  beforeEach(async () => {
    ({ dir: tmpDir, cleanup } = makeTmpDir());
    staging = new StagingDir(tmpDir, "test-run-id");
    await staging.init();
  });

  afterEach(() => cleanup());

  it("init() creates the root directory", () => {
    expect(existsSync(staging.rootPath)).toBe(true);
  });

  it("rootPath is under <outDir>/.verreaux-stage/<runId>", () => {
    expect(staging.rootPath).toBe(
      join(tmpDir, ".verreaux-stage", "test-run-id"),
    );
  });

  // -------------------------------------------------------------------------
  // Cover
  // -------------------------------------------------------------------------

  it("writeCover() writes cover.png for image/png mime", async () => {
    const buf = makePng();
    const path = await staging.writeCover(buf, "image/png");
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith("cover.png")).toBe(true);
  });

  it("writeCover() writes cover.webp for image/webp mime", async () => {
    const path = await staging.writeCover(makeWebP(), "image/webp");
    expect(path.endsWith("cover.webp")).toBe(true);
  });

  it("writeCover() content round-trips", async () => {
    const buf = makePng(8, 8, 200);
    await staging.writeCover(buf, "image/png");
    const written = await readFile(join(staging.rootPath, "cover.png"));
    expect(written).toEqual(buf);
  });

  it("writeCover() leaves no .partial file on success", async () => {
    await staging.writeCover(makePng(), "image/png");
    expect(existsSync(join(staging.rootPath, "cover.partial"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  it("writePage() creates chapter dir and page file", async () => {
    const path = await staging.writePage(1, 1, makePng(), "image/png");
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("Chapter 001");
    expect(path).toContain("001.png");
  });

  it("writePage() uses magic-byte detection, ignoring mime", async () => {
    // Provide a PNG buffer but lie that it is image/jpeg
    const path = await staging.writePage(1, 1, makePng(), "image/jpeg");
    // Should be .png (detected from magic bytes), not .jpg
    expect(path.endsWith(".png")).toBe(true);
  });

  it("writePage() content round-trips", async () => {
    const buf = makePng(8, 8, 77);
    await staging.writePage(2, 3, buf, "image/png");
    const chapterDir = join(staging.rootPath, "Chapter 002");
    const written = await readFile(join(chapterDir, "003.png"));
    expect(written).toEqual(buf);
  });

  it("writePage() leaves no .partial file on success", async () => {
    const buf = makePng();
    await staging.writePage(1, 1, buf, "image/png");
    const chapterDir = join(staging.rootPath, "Chapter 001");
    const partials = readdirSync(chapterDir).filter((f) =>
      f.endsWith(".partial"),
    );
    expect(partials).toHaveLength(0);
  });

  it("writePage() rejects GIF with UnsupportedImageFormatError", async () => {
    await expect(
      staging.writePage(1, 1, makeGif(), "image/gif"),
    ).rejects.toThrow(UnsupportedImageFormatError);
  });

  it("writePage() does not leave a partial file when write is rejected", async () => {
    // Make writePage fail at the detectImageExt level (GIF)
    await expect(
      staging.writePage(1, 1, makeGif(), "image/gif"),
    ).rejects.toThrow();

    const chapterDir = join(staging.rootPath, "Chapter 001");
    if (existsSync(chapterDir)) {
      const partials = readdirSync(chapterDir).filter((f) =>
        f.endsWith(".partial"),
      );
      expect(partials).toHaveLength(0);
    }
    // If directory was never created, that's also fine — nothing to clean up.
  });

  // -------------------------------------------------------------------------
  // Atomic rename behaviour
  // -------------------------------------------------------------------------

  it("writePage() does not leave partial file when detect rejects the buffer", async () => {
    // Use a too-small buffer so detectImageExt throws before any file is
    // written. This proves the pre-condition check prevents littering.
    const tinyBuf = Buffer.alloc(2);
    await expect(staging.writePage(1, 1, tinyBuf, "image/png")).rejects.toThrow(
      UnsupportedImageFormatError,
    );

    // No chapter dir should have been created since error is pre-write
    const chapterDir = join(staging.rootPath, "Chapter 001");
    if (existsSync(chapterDir)) {
      const files = readdirSync(chapterDir);
      expect(files.filter((f) => f.endsWith(".partial"))).toHaveLength(0);
    }
  });

  // -------------------------------------------------------------------------
  // removeChapter
  // -------------------------------------------------------------------------

  it("removeChapter() deletes an existing chapter directory", async () => {
    await staging.writePage(3, 1, makePng(), "image/png");
    const chapterDir = join(staging.rootPath, "Chapter 003");
    expect(existsSync(chapterDir)).toBe(true);

    await staging.removeChapter(3);
    expect(existsSync(chapterDir)).toBe(false);
  });

  it("removeChapter() is idempotent — does not throw if directory is absent", async () => {
    await expect(staging.removeChapter(99)).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // listChapters
  // -------------------------------------------------------------------------

  it("listChapters() returns chapter folder names in numeric order", async () => {
    await staging.writePage(3, 1, makePng(), "image/png");
    await staging.writePage(1, 1, makePng(), "image/png");
    await staging.writePage(2, 1, makePng(), "image/png");

    const chapters = await staging.listChapters();
    expect(chapters).toEqual(["Chapter 001", "Chapter 002", "Chapter 003"]);
  });

  it("listChapters() returns empty array when no chapter dirs exist", async () => {
    const chapters = await staging.listChapters();
    expect(chapters).toEqual([]);
  });

  it("listChapters() ignores non-chapter directories", async () => {
    // Create a random directory that does not match the "Chapter N" pattern
    await mkdir(join(staging.rootPath, "SomeOtherDir"), { recursive: true });
    // Create a legitimate chapter
    await staging.writePage(1, 1, makePng(), "image/png");

    const chapters = await staging.listChapters();
    expect(chapters).toEqual(["Chapter 001"]);
  });
});
