/**
 * Packager — builds the final series ZIP from a completed StagingDir.
 *
 * ZIP contract (§1 workflow.md):
 * - Top-level folder = sanitizeSeriesName(seriesTitle)
 * - Pages stored with ZIP_STORED (method 0) — already-compressed images
 * - Cover may use DEFLATE (small, often PNG)
 * - Atomic write: build to <outPath>.zip.tmp, then fs.rename to final
 * - UTF-8 filenames
 * - No hidden files, no empty folders
 *
 * Implementation note: uses `archiver` to stream entries to disk so we never
 * hold the whole ZIP in a Buffer (Node's Buffer cap is ~2 GB; full-series
 * dumps exceed that).
 *
 * Events emitted (§13.5 packager.*):
 *   package.started → PackageStartedPayload
 *   package.written → PackageWrittenPayload
 *   run.fatal       → on failure (ERR_PACKAGE_FAILED)
 */

import { createWriteStream } from "node:fs";
import { readFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Archiver, ArchiverOptions } from "archiver";

import type { EventBus } from "../core/events.js";
import type { VerreauxManifest } from "../pi/manifest.js";
import { sanitizeSeriesName } from "./sanitize.js";
import type { StagingDir } from "./staging.js";

// archiver v7 is a CommonJS factory. Under NodeNext ESM resolution Node
// doesn't synthesize a default export from `module.exports = function`, so we
// load it through createRequire.
const _require = createRequire(import.meta.url);
const archiver = _require("archiver") as (
  format: "zip",
  options?: ArchiverOptions,
) => Archiver;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PackagerBuildOpts {
  /** Absolute path (without .zip extension) where the final ZIP is written. */
  outPath: string;
  /** Raw series title — will be sanitized for the ZIP folder name. */
  seriesTitle: string;
  /**
   * When false, the build refuses to proceed if any chapter folder contains
   * fewer pages than the expected count.
   */
  allowPartial: boolean;
  /**
   * Expected page count per chapter order value. Supplied by the pipeline from
   * run-state. Only consulted when `allowPartial` is false.
   */
  expectedPagesPerChapter?: Map<number, number>;
  /**
   * When supplied, a `verreaux.json` file carrying source provenance is written
   * at the ZIP root (alongside the series folder, not inside it).
   */
  manifest?: VerreauxManifest;
}

export interface PackagerBuildResult {
  path: string;
  byteLength: number;
  chapterCount: number;
  pageCount: number;
}

// ---------------------------------------------------------------------------
// Packager
// ---------------------------------------------------------------------------

/** Cover file extensions that benefit from DEFLATE (text/lossless). */
const DEFLATE_COVER_EXTS = new Set([".png", ".svg"]);

const IMAGE_EXTS = new Set([".webp", ".jpg", ".jpeg", ".png", ".svg"]);

export class Packager {
  constructor(private readonly bus: EventBus) {}

  async build(
    stagingDir: StagingDir,
    opts: PackagerBuildOpts,
  ): Promise<PackagerBuildResult> {
    const chapterNames = await stagingDir.listChapters();

    this.bus.emit("package.started", { chapterCount: chapterNames.length });

    const tmpPath = `${opts.outPath}.zip.tmp`;
    const finalPath = `${opts.outPath}.zip`;
    const seriesFolder = sanitizeSeriesName(opts.seriesTitle);

    try {
      if (!opts.allowPartial && opts.expectedPagesPerChapter != null) {
        await this.validateCompleteness(
          stagingDir,
          chapterNames,
          opts.expectedPagesPerChapter,
        );
      }

      const { chapterCount, pageCount } = await this.streamZip(
        stagingDir,
        seriesFolder,
        chapterNames,
        tmpPath,
        opts.manifest,
      );

      await rename(tmpPath, finalPath);

      const byteLength = (await stat(finalPath)).size;

      this.bus.emit("package.written", {
        zipPath: finalPath,
        bytes: byteLength,
      });

      return { path: finalPath, byteLength, chapterCount, pageCount };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);

      this.bus.emit("run.fatal", {
        code: "ERR_PACKAGE_FAILED",
        message: err instanceof Error ? err.message : String(err),
        state: "PACKAGE_ZIP",
      });

      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async validateCompleteness(
    stagingDir: StagingDir,
    chapterNames: readonly string[],
    expectedPagesPerChapter: Map<number, number>,
  ): Promise<void> {
    for (const chapterName of chapterNames) {
      const chapterOrder = extractSortKey(chapterName);
      const expected = expectedPagesPerChapter.get(chapterOrder);
      if (expected === undefined) continue;
      const chapterDir = join(stagingDir.rootPath, chapterName);
      const pageFiles = await this.listPageFiles(chapterDir);
      if (pageFiles.length < expected) {
        throw new PackageIncompletenessError(
          chapterName,
          expected,
          pageFiles.length,
        );
      }
    }
  }

  private async streamZip(
    stagingDir: StagingDir,
    seriesFolder: string,
    chapterNames: readonly string[],
    tmpPath: string,
    manifest?: VerreauxManifest,
  ): Promise<{ chapterCount: number; pageCount: number }> {
    const output = createWriteStream(tmpPath);
    // Default store=true; per-entry override for the PNG cover.
    const archive = archiver("zip", { store: true });

    // The archive stream can emit errors independently of the write stream;
    // bridge both to a single promise so callers see the failure.
    const closed = new Promise<void>((resolve, reject) => {
      output.on("close", () => resolve());
      output.on("error", reject);
      archive.on("error", reject);
      // `warning` for ENOENT/stat issues — escalate, since silent skips would
      // produce a successful-looking ZIP with missing pages.
      archive.on("warning", reject);
    });

    archive.pipe(output);

    if (manifest) {
      archive.append(JSON.stringify(manifest, null, 2), {
        name: "verreaux.json",
        store: false,
      });
    }

    let totalPages = 0;
    let chapterCount = 0;

    try {
      // --- Cover ---
      const coverEntry = await this.findCover(stagingDir.rootPath);
      if (coverEntry) {
        const { filename, buffer } = coverEntry;
        const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
        const useDeflate = DEFLATE_COVER_EXTS.has(ext);
        archive.append(buffer, {
          name: `${seriesFolder}/${filename}`,
          store: !useDeflate,
        });
      }

      // --- Chapters ---
      for (const chapterName of chapterNames) {
        const chapterDir = join(stagingDir.rootPath, chapterName);
        const pageFiles = await this.listPageFiles(chapterDir);

        for (const pageFile of pageFiles) {
          const buffer = await readFile(join(chapterDir, pageFile));
          archive.append(buffer, {
            name: `${seriesFolder}/${chapterName}/${pageFile}`,
            store: true,
          });
          totalPages++;
        }

        chapterCount++;
      }

      await archive.finalize();
      await closed;
    } catch (err) {
      // Best-effort: tear down the archive/stream so the outer cleanup can
      // remove the tmp file. Abort is sync on archiver; destroy on output.
      archive.abort();
      output.destroy();
      throw err;
    }

    return { chapterCount, pageCount: totalPages };
  }

  /** Finds the cover file in the staging root, returns filename + buffer or null. */
  private async findCover(
    rootPath: string,
  ): Promise<{ filename: string; buffer: Buffer } | null> {
    const COVER_RE = /^cover\.(webp|jpg|jpeg|png)$/i;
    const entries = await readdir(rootPath, { withFileTypes: true });
    const coverEntry = entries.find(
      (e) => e.isFile() && COVER_RE.test(e.name),
    );
    if (!coverEntry) return null;
    const buffer = await readFile(join(rootPath, coverEntry.name));
    return { filename: coverEntry.name, buffer };
  }

  /** Returns image filenames in a chapter directory, sorted by page number. */
  private async listPageFiles(chapterDir: string): Promise<string[]> {
    const entries = await readdir(chapterDir, { withFileTypes: true });
    const images = entries
      .filter((e) => {
        if (!e.isFile()) return false;
        const dot = e.name.lastIndexOf(".");
        if (dot < 0) return false;
        return IMAGE_EXTS.has(e.name.slice(dot).toLowerCase());
      })
      .map((e) => e.name);

    images.sort((a, b) => extractSortKey(a) - extractSortKey(b));
    return images;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PackageIncompletenessError extends Error {
  constructor(
    public readonly chapterName: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Chapter "${chapterName}" is incomplete: expected ${expected} pages, found ${actual}. ` +
        `Pass allowPartial=true or fix the chapter before packaging.`,
    );
    this.name = "PackageIncompletenessError";
  }
}

// ---------------------------------------------------------------------------
// Internal sort-key helper (mirrors app/src/lib/naturalSort.ts)
// ---------------------------------------------------------------------------

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
