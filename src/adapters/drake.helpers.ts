// ---------------------------------------------------------------------------
// drake.helpers.ts — pure parse helpers for the drakecomic.org adapter.
//
// All functions are side-effect-free and exported for unit testing.
// No HTTP, no I/O. Cheerio is the only external dependency.
//
// Theme: WordPress MangaReader (Themesia). Reader page emits an inline
//   <script>ts_reader.run({...});</script>
// whose JSON literal carries the full image list. There is no AJAX call.
//
// Unlike arenascan, drakecomic.org sets og:image to the site-wide logo, so
// parseSeriesMetadata reads the cover from the series page's div.thumb img.
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawChapter {
  /** Absolute chapter URL, already resolved against origin. */
  url: string;
  /** Extracted decimal chapter number, e.g. 0, 1, 2.5, 226. */
  number: number;
}

export interface SeriesMetadata {
  title: string;
  coverUrl: string;
}

/** Parsed `ts_reader.run({...})` payload — only the fields we use. */
export interface TsReaderConfig {
  readonly post_id: number;
  readonly sources: ReadonlyArray<{
    readonly source: string;
    readonly images: readonly string[];
  }>;
  readonly defaultSource?: string;
}

// ---------------------------------------------------------------------------
// parseSeriesMetadata
//
// Title selector: h1.entry-title (Themesia convention).
// Cover:          div.thumb img[src]. og:image on drakecomic.org points at the
//                 site-wide logo, not the series cover.
// ---------------------------------------------------------------------------

export function parseSeriesMetadata(html: string): SeriesMetadata {
  const $ = cheerio.load(html);

  const title = $("h1.entry-title").first().text().trim();

  if (!title) {
    throw new DrakeParseError(
      "parseSeriesMetadata: could not extract title — h1.entry-title not found",
    );
  }

  const coverUrl =
    $("div.thumb img").first().attr("src")?.trim() ?? "";

  return { title, coverUrl };
}

// ---------------------------------------------------------------------------
// parseChapterList
//
// Themesia chapter list markup:
//   <div id="chapterlist"><ul>
//     <li data-num="230">
//       <div class="chbox"><div class="eph-num">
//         <a href="..."><span class="chapternum">Chapter 230</span>...</a>
//       </div></div>
//     </li>
//     ...
//   </ul></div>
//
// Newest-first in DOM order. Returns them in source order; the caller is
// responsible for sorting ascending.
// ---------------------------------------------------------------------------

export function parseChapterList(html: string, origin: string): RawChapter[] {
  const $ = cheerio.load(html);
  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  $("#chapterlist li").each((_i, el) => {
    const $li = $(el);
    const href = ($li.find("a[href]").first().attr("href") ?? "").trim();
    if (!href) return;

    const url = toAbsoluteUrl(href, origin);

    // Prefer the explicit data-num attribute; fall back to the link text.
    const dataNum = ($li.attr("data-num") ?? "").trim();
    let number = dataNum ? parseFloat(dataNum) : NaN;

    if (isNaN(number)) {
      const label = $li.find(".chapternum").first().text().trim()
        || $li.find("a").first().text().trim();
      number = extractChapterNumber(label);
    }

    if (isNaN(number) || seen.has(number)) return;
    seen.add(number);

    chapters.push({ url, number });
  });

  return chapters;
}

// ---------------------------------------------------------------------------
// extractTsReaderConfig
//
// Extracts the JSON literal passed to `ts_reader.run(...)` from inline script.
// The literal is plain JSON (with `\/` escapes for slashes, which JSON.parse
// accepts) — no need to evaluate JavaScript.
// ---------------------------------------------------------------------------

const TS_READER_RE = /ts_reader\.run\(\s*(\{[\s\S]*?\})\s*\)\s*;?/;

export function extractTsReaderConfig(html: string): TsReaderConfig | null {
  const match = TS_READER_RE.exec(html);
  if (!match || !match[1]) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }

  if (!isTsReaderConfig(parsed)) return null;
  return parsed;
}

function isTsReaderConfig(value: unknown): value is TsReaderConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["sources"])) return false;
  for (const s of v["sources"]) {
    if (typeof s !== "object" || s === null) return false;
    const src = s as Record<string, unknown>;
    if (!Array.isArray(src["images"])) return false;
    if (!src["images"].every((u: unknown) => typeof u === "string")) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// pickImageList
//
// Choose the image list from `sources`. Honour `defaultSource` if it points
// at a source that has a non-empty image list; otherwise fall back to the
// first source that does.
// ---------------------------------------------------------------------------

export function pickImageList(cfg: TsReaderConfig): readonly string[] {
  const preferred = cfg.defaultSource
    ? cfg.sources.find((s) => s.source === cfg.defaultSource && s.images.length > 0)
    : undefined;

  if (preferred) return preferred.images;

  const firstNonEmpty = cfg.sources.find((s) => s.images.length > 0);
  return firstNonEmpty?.images ?? [];
}

// ---------------------------------------------------------------------------
// extractChapterNumber
//
// Regex extraction from chapter link text. Mirrors the arenascan helper so
// edge cases stay consistent across adapters.
// ---------------------------------------------------------------------------

export function extractChapterNumber(linkText: string): number {
  const match = /(?:chapter|ch\.?)\s*([\d]+(?:\.[\d]+)?)/i.exec(linkText);
  if (match?.[1]) {
    return parseFloat(match[1]);
  }
  const fallback = /\b(\d+(?:\.\d+)?)\b/.exec(linkText);
  if (fallback?.[1]) {
    return parseFloat(fallback[1]);
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class DrakeParseError extends Error {
  override readonly name = "DrakeParseError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function toAbsoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(href, base).toString();
}
