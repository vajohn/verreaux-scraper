// ---------------------------------------------------------------------------
// hivetoons.helpers.ts — pure parse helpers for hivetoons.org
//
// Side-effect free. Uses cheerio to extract series metadata, chapter list and
// image URLs from chapter pages. Exported for unit testing.
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawChapter {
  url: string;
  number: number;
  title?: string | null;
}

export interface SeriesMetadata {
  title: string;
  coverUrl: string;
}

// ---------------------------------------------------------------------------
// parseSeriesPage
//
// Extracts title, cover, and a list of chapter links from a hivetoons series
// page. Chapters are returned in DOM order (newest-first on many sites) and the
// caller may sort ascending if needed.
// ---------------------------------------------------------------------------

export function parseSeriesPage(html: string, origin: string): { title: string; coverUrl: string; chapters: RawChapter[] } {
  const $ = cheerio.load(html);

  // Title: try h1, then og:title
  let title = $("h1").first().text().trim();
  if (!title) title = $("meta[property='og:title']").attr("content")?.trim() ?? "";
  if (!title) throw new HivetoonsParseError("parseSeriesPage: title not found");

  // DEBUG: Log what we found
  const h1Count = $("h1").length;
  const ogTitleVal = $("meta[property='og:title']").attr("content");
  console.error(`[DEBUG parseSeriesPage] h1=${h1Count} h1Text='${$("h1").first().text()}' ogTitle='${ogTitleVal}' final='${title}'`);

  // Cover: prefer og:image then obvious img.cover
  const coverUrl = $("meta[property='og:image']").attr("content")?.trim() ?? $("img.cover").attr("src")?.trim() ?? "";

  // Chapters: look for anchors under common containers
  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  const candidateSelectors = [
    ".chapters a[href]",
    ".chapter-list a[href]",
    ".listing a[href]",
    "a[href*='/chapter/']",
    "a[href*='/ch-']",
  ];

  $(candidateSelectors.join(",")).each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href) return;
    const url = toAbsoluteUrl(href, origin);
    const text = $(el).text().trim();
    const number = extractChapterNumber(text) || extractChapterNumberFromHref(href);
    if (isNaN(number)) return;
    if (seen.has(number)) return;
    seen.add(number);
    chapters.push({ url, number, title: text || null });
  });

  // DEBUG: Log chapter search results
  const selectorResults = candidateSelectors.map(sel => `${sel}=${$(sel).length}`);
  console.error(`[DEBUG parseSeriesPage] chapter search: ${selectorResults.join(' ')} -> found ${chapters.length} chapters`);

  return { title, coverUrl, chapters };
}

// ---------------------------------------------------------------------------
// parseChapterPage
//
// Extracts image URLs from a chapter page HTML. Handles lazy attributes and
// srcset. Returns normalized absolute URLs when base is provided.
// ---------------------------------------------------------------------------

export function parseChapterPage(html: string, base?: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];

  // Common lazy attributes
  const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-srcset", "data-original-src"];

  // First, collect img[src] and lazy attributes
  $("img").each((_i, el) => {
    const $el = $(el);
    let src = ($el.attr("src") ?? "").trim();
    if (!src) {
      for (const a of lazyAttrs) {
        const cand = ($el.attr(a) ?? "").trim();
        if (cand) {
          src = cand;
          break;
        }
      }
    }

    // srcset handling: take the largest candidate (last after splitting by comma)
    if (!src) {
      const srcset = ($el.attr("srcset") ?? "").trim();
      if (srcset) {
        const parts = srcset.split(",").map((s) => s.trim()).filter(Boolean);
            if (parts.length > 0) {
              const last = parts[parts.length - 1];
              if (last) {
                const firstToken = last.split(/\s+/)[0];
                if (firstToken) src = firstToken;
              }
            }
      }
    }

    if (!src) return;
    const abs = base ? toAbsoluteUrl(src, base) : src;
    urls.push(abs);
  });

  // If none found, try to extract from inline script arrays
  if (urls.length === 0) {
    const arr = extractImageArrayFromScript(html);
    if (arr && arr.length > 0) {
      return arr.map((u) => (base ? toAbsoluteUrl(u, base) : u));
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractImageArrayFromScript
//
// Looks for simple inline JS patterns that embed an array of image URLs, e.g.
//   var images = ["https://...","https://..."]
// or window.pages = [...]; Returns null if nothing found.
// ---------------------------------------------------------------------------

export function extractImageArrayFromScript(html: string): string[] | null {
  // Find the first JS array literal in an inline script that looks like an
  // array of string URLs. This handles patterns like:
  //   var images = ["https://...", "https://..."]
  //   images = ['...','...']
  const re = /(var|let|const|window)?\s*[^=\n]*=\s*(\[[\s\S]*?\])/i;
  const match = re.exec(html);
  if (!match || !match[2]) return null;
  const raw = match[2];
  // Try to coerce into valid JSON: replace single quotes with double quotes
  // and remove trailing commas.
  try {
    let jsonish = raw.replace(/\'/g, '"');
    jsonish = jsonish.replace(/,\s*\]/g, "]");
    const arr = JSON.parse(jsonish) as unknown;
    if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// extractChapterNumberFromHref — fallback that parses digits from URL.
// ---------------------------------------------------------------------------

export function extractChapterNumberFromHref(href: string): number {
  const m = /chapter-?(\d+(?:\.\d+)?)/i.exec(href) ?? /ch-?(\d+(?:\.\d+)?)/i.exec(href) ?? /-(\d+(?:\.\d+)?)(?:\/|$)/.exec(href);
  if (m && m[1]) return parseFloat(m[1]);
  const fallback = /(?:\b)(\d+(?:\.\d+)?)(?:\b)/.exec(href);
  if (fallback && fallback[1]) return parseFloat(fallback[1]);
  return NaN;
}

// ---------------------------------------------------------------------------
// extractChapterNumber — similar to manhuaplus helper
// ---------------------------------------------------------------------------

export function extractChapterNumber(linkText: string): number {
  const match = /(?:chapter|ch\.?|ep(?:isode)?)\s*([\d]+(?:\.[\d]+)?)/i.exec(linkText);
  if (match?.[1]) return parseFloat(match[1]);
  const fallback = /\b(\d+(?:\.\d+)?)\b/.exec(linkText);
  if (fallback?.[1]) return parseFloat(fallback[1]);
  return NaN;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class HivetoonsParseError extends Error {
  override readonly name = "HivetoonsParseError";
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






