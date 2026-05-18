/**
 * importerProxy.ts — test-only shim of the PWA importer.
 *
 * WHY THIS FILE EXISTS (not a source copy):
 * The canonical source lives in app/src/features/import/zipWalker.ts and
 * app/src/lib/naturalSort.ts.  Those files cannot be imported directly from
 * the scraper's vitest context because:
 *
 *   1. The app uses `moduleResolution: "bundler"` + `module: "esnext"` and
 *      TypeScript with `.ts` extension imports — incompatible with the
 *      scraper's `moduleResolution: "NodeNext"`.
 *   2. The app's tsconfig includes `"lib": ["DOM", "WebWorker"]`, which
 *      introduces global types that conflict with the scraper's Node-only env.
 *   3. The app's `jszip` lives in app/node_modules (not symlinked here), so
 *      the `import type JSZip from 'jszip'` in zipWalker.ts would resolve to a
 *      different copy.
 *
 * This shim is a verbatim copy of the logic from:
 *   app/src/features/import/zipWalker.ts  (walkChapter, walkSeries)
 *   app/src/lib/naturalSort.ts            (extractSortKey, stemOf, extOf)
 *
 * It is updated whenever the canonical source changes.  The integration test
 * asserts the same observable contract (SeriesEntry shape, chapter/page order)
 * that the real importer produces.
 *
 * DO NOT import this file from src/ — it is test-only infrastructure.
 */

import type JSZip from "jszip";

// ---------------------------------------------------------------------------
// From app/src/lib/naturalSort.ts
// ---------------------------------------------------------------------------

export function extractSortKey(input: string): number {
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

export function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// From app/src/features/import/typeDetector.ts (subset)
// ---------------------------------------------------------------------------

const IMAGE_EXTS_SET = new Set([".webp", ".jpg", ".jpeg", ".png"]);

// ---------------------------------------------------------------------------
// From app/src/features/import/zipWalker.ts
// ---------------------------------------------------------------------------

export interface PageEntry {
  path: string;
  pageNumber: number;
}

export interface ChapterEntry {
  title: string;
  order: number;
  pages: PageEntry[];
}

export interface SeriesEntry {
  title: string;
  coverPath: string | null;
  chapters: ChapterEntry[];
}

interface DirectChildren {
  files: string[];
  folders: string[];
}

function getDirectChildren(zip: JSZip, folder: string): DirectChildren {
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  const files = new Set<string>();
  const folders = new Set<string>();
  zip.forEach((path) => {
    if (!path.startsWith(prefix) || path === prefix) return;
    const rest = path.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length === 1 && parts[0]) {
      files.add(`${prefix}${parts[0]}`);
    } else if (parts.length >= 2 && parts[0]) {
      folders.add(`${prefix}${parts[0]}/`);
    }
  });
  return { files: Array.from(files), folders: Array.from(folders) };
}

const COVER_RE = /^cover\.(webp|jpg|jpeg|png)$/i;

export async function walkChapter(
  zip: JSZip,
  chapterPath: string,
  order: number,
): Promise<ChapterEntry> {
  const title = chapterPath.replace(/\/$/, "").split("/").pop() ?? "Chapter";
  const { files } = getDirectChildren(zip, chapterPath);
  const imageFiles: PageEntry[] = files
    .filter((f) => IMAGE_EXTS_SET.has(extOf(f)))
    .map((f) => ({
      path: f,
      pageNumber: extractSortKey(stemOf(f.split("/").pop() ?? "")),
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  return { title, order, pages: imageFiles };
}

export async function walkSeries(
  zip: JSZip,
  seriesPath: string,
): Promise<SeriesEntry> {
  const title = seriesPath.replace(/\/$/, "").split("/").pop() ?? "Series";
  const { files, folders } = getDirectChildren(zip, seriesPath);
  const coverFile =
    files.find((f) =>
      COVER_RE.test((f.split("/").pop() ?? "").toLowerCase()),
    ) ?? null;

  const chapterFolders = folders
    .map((folder) => ({
      folder,
      order: extractSortKey(folder.replace(/\/$/, "").split("/").pop() ?? ""),
    }))
    .sort((a, b) => a.order - b.order);

  const chapters = await Promise.all(
    chapterFolders.map(({ folder, order }) => walkChapter(zip, folder, order)),
  );

  return {
    title,
    coverPath: coverFile,
    chapters: chapters.filter((c) => c.pages.length > 0),
  };
}

/** Returns the top-level folder paths (e.g. "Solo Leveling/"). */
export function getTopLevelFolders(zip: JSZip): string[] {
  const folders = new Set<string>();
  zip.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 2) {
      folders.add(`${parts[0]}/`);
    }
  });
  return Array.from(folders);
}
