/**
 * StagingDir — on-disk staging tree.
 *
 * Layout (§17 / §2):
 *   <runOutDir>/.verreaux-stage/<run-id>/
 *     cover.<ext>
 *     Chapter 000/
 *       001.<ext>
 *       002.<ext>
 *       ...
 *     Chapter 001/
 *       ...
 *
 * All writes use an atomic .partial → rename pattern so a killed process never
 * leaves a half-written file in the tree.
 *
 * The mime → ext mapping for pages uses magic-byte detection (not the
 * Content-Type header) as a defence-in-depth measure, since CDNs and scraped
 * sources sometimes lie about Content-Type.
 */

import { mkdir, rename, unlink, rm, readdir } from "node:fs/promises";
import { createWriteStream, rename as renameSync } from "node:fs";
import { join, basename } from "node:path";
import { promisify } from "node:util";

import {
  formatChapterFolder,
  formatPageFilename,
  pickCoverFilename,
} from "./sanitize.js";

const renameAsync = promisify(renameSync);

// ---------------------------------------------------------------------------
// Magic-byte detection
// ---------------------------------------------------------------------------

export class UnsupportedImageFormatError extends Error {
  constructor(
    public readonly detectedFormat: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedImageFormatError";
  }
}

/**
 * Detects image format from the first bytes of a buffer and returns the
 * canonical extension (with leading dot).
 *
 * Supported: PNG, JPEG, WebP.
 * Rejected with `UnsupportedImageFormatError`: GIF, BMP, SVG (and anything else).
 */
export function detectImageExt(buf: Buffer): ".png" | ".jpg" | ".webp" {
  if (buf.length < 3) {
    throw new UnsupportedImageFormatError(
      "unknown",
      "Buffer too small to detect image format",
    );
  }

  // PNG: 89 50 4E 47 (need 4 bytes)
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return ".png";
  }

  // JPEG: FF D8 FF (3 bytes)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return ".jpg";
  }

  // GIF: 47 49 46 ('GIF') — checked BEFORE WebP/length guard
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    throw new UnsupportedImageFormatError(
      "gif",
      "GIF images are not accepted; convert to PNG or WebP first",
    );
  }

  // BMP: 42 4D ('BM') — 2 bytes
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    throw new UnsupportedImageFormatError(
      "bmp",
      "BMP images are not accepted; convert to PNG or WebP first",
    );
  }

  // WebP: RIFF .... WEBP  (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP") — need 12 bytes
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return ".webp";
  }

  // SVG: check for '<svg' or '<?xml' near the start (text-based)
  const prefix = buf.slice(0, 256).toString("utf8");
  if (
    prefix.includes("<svg") ||
    prefix.includes("<?xml") ||
    prefix.includes("<!DOCTYPE svg")
  ) {
    throw new UnsupportedImageFormatError(
      "svg",
      "SVG images are not accepted; rasterize to PNG or WebP first",
    );
  }

  throw new UnsupportedImageFormatError(
    "unknown",
    `Unrecognised image format (magic bytes: ${buf.slice(0, 4).toString("hex")})`,
  );
}

// ---------------------------------------------------------------------------
// StagingDir
// ---------------------------------------------------------------------------

export class StagingDir {
  /** Absolute path to the root of this run's staging tree. */
  readonly rootPath: string;

  constructor(
    /** The base output directory for the run (i.e. `--out`). */
    runOutDir: string,
    /** The run ID (uuidv7). Used as the leaf directory name. */
    runId: string,
  ) {
    this.rootPath = join(runOutDir, ".verreaux-stage", runId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Creates the staging root directory (parents included). */
  async init(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Cover
  // -------------------------------------------------------------------------

  /**
   * Writes the cover image atomically.
   *
   * The mime argument determines the filename (`cover.webp`, `cover.png`, …).
   * Writes to `cover.partial` first, then renames to the final name.
   */
  async writeCover(buffer: Buffer, mime: string): Promise<string> {
    const filename = pickCoverFilename(mime);
    const finalPath = join(this.rootPath, filename);
    const partialPath = join(this.rootPath, "cover.partial");

    await atomicWrite(partialPath, finalPath, buffer);
    return finalPath;
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  /**
   * Writes a single page image atomically.
   *
   * - Chapter folder is created if it does not exist.
   * - The extension is determined by magic-byte detection of `buffer` (NOT by
   *   the supplied `mime` string — CDNs lie).
   * - Atomic: written to `<chapterDir>/<page>.partial`, then renamed.
   *
   * @param chapterOrder  The chapter number (float), used to name the folder.
   * @param pageNumber    1-based page index within the chapter.
   * @param buffer        Raw image bytes.
   * @param _mime         Content-Type hint — IGNORED for ext detection; kept for
   *                      API symmetry with the pipeline caller.
   */
  async writePage(
    chapterOrder: number,
    pageNumber: number,
    buffer: Buffer,
    _mime: string,
  ): Promise<string> {
    const ext = detectImageExt(buffer);
    const chapterDir = join(this.rootPath, formatChapterFolder(chapterOrder));
    await mkdir(chapterDir, { recursive: true });

    const filename = formatPageFilename(pageNumber, ext);
    const finalPath = join(chapterDir, filename);
    const partialPath = join(chapterDir, `${filename}.partial`);

    await atomicWrite(partialPath, finalPath, buffer);
    return finalPath;
  }

  // -------------------------------------------------------------------------
  // Cleanup helpers
  // -------------------------------------------------------------------------

  /**
   * Removes an entire chapter directory (used during retry/resume to wipe a
   * partially-written chapter before re-downloading it).
   */
  async removeChapter(chapterOrder: number): Promise<void> {
    const chapterDir = join(this.rootPath, formatChapterFolder(chapterOrder));
    await rm(chapterDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Enumeration
  // -------------------------------------------------------------------------

  /**
   * Returns chapter folder names (not full paths) sorted in natural order.
   * Uses the same sort key as `extractSortKey` from app/src/lib/naturalSort.ts
   * so the ordering matches exactly what the PWA importer expects.
   */
  async listChapters(): Promise<string[]> {
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const chapterDirs = entries
      .filter((e) => e.isDirectory() && /^Chapter\s+\d/.test(e.name))
      .map((e) => e.name);

    // Natural sort: parse the leading number (same as extractSortKey)
    chapterDirs.sort((a, b) => extractSortKey(a) - extractSortKey(b));
    return chapterDirs;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Writes `buffer` to `partialPath` then atomically renames it to `finalPath`.
 * On any error, attempts to unlink the partial file to avoid littering.
 */
async function atomicWrite(
  partialPath: string,
  finalPath: string,
  buffer: Buffer,
): Promise<void> {
  try {
    await writeBuffer(partialPath, buffer);
    await rename(partialPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the partial file
    await unlink(partialPath).catch(() => undefined);
    throw err;
  }
}

/** Writes a Buffer to a file path using a promise-based write stream. */
function writeBuffer(filePath: string, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    ws.on("error", reject);
    ws.on("finish", resolve);
    ws.end(buffer);
  });
}

/**
 * Minimal replica of `extractSortKey` from app/src/lib/naturalSort.ts.
 * Used only for sorting chapter folder names in `listChapters()`.
 * Kept here to avoid a cross-package import at runtime.
 */
function extractSortKey(input: string): number {
  if (!input) return 0;
  const match = input.match(/(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  const intPart = match[1] ?? "0";
  const fracPart = match[2];
  if (fracPart !== undefined) {
    return parseFloat(`${intPart}.${fracPart}`);
  }
  return parseInt(intPart, 10);
}
