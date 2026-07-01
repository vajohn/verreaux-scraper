// ---------------------------------------------------------------------------
// manhuaplus.helpers.ts — pure parse helpers for the ManhuaPlus / Liliana adapter.
//
// All functions are side-effect-free and exported for unit testing.
// No HTTP, no I/O. Cheerio is the only external dependency.
//
// Theme: liliana (custom theme, post-Madara migration as of 2025-06).
// CDN:   cdn.manhuaplus.cc
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";
import type { SeriesSearchResult } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RawChapter {
  /** Absolute chapter URL, already resolved against origin. */
  url: string;
  /** Extracted decimal chapter number, e.g. 0, 1, 2.5, 74. */
  number: number;
}

export interface SeriesMetadata {
  title: string;
  coverUrl: string;
}

// ---------------------------------------------------------------------------
// parseSeriesMetadata
//
// Extracts title and cover image URL from a Liliana-theme series page.
//
// Title selector: h1.mt-0.mb-6.fs-20 (the unique h1 on the detail page)
// Cover:          og:image meta tag
// ---------------------------------------------------------------------------

export function parseSeriesMetadata(html: string): SeriesMetadata {
  const $ = cheerio.load(html);

  const title = $("h1.mt-0.mb-6.fs-20").first().text().trim();

  if (!title) {
    throw new LilianaParseError(
      "parseSeriesMetadata: could not extract title — h1.mt-0.mb-6.fs-20 not found",
    );
  }

  const coverUrl =
    $("meta[property='og:image']").attr("content")?.trim() ?? "";

  return { title, coverUrl };
}

// ---------------------------------------------------------------------------
// parseChapterList
//
// Parses the server-rendered chapter list from a Liliana series page.
//
// Structure:
//   <li class="chapter">
//     <a href="https://manhuaplus.org/manga/<slug>/chapter-<N>">Chapter N</a>
//   </li>
//
// Chapters are listed newest-first in DOM order. Returns them in source order;
// the caller is responsible for sorting ascending if needed.
// ---------------------------------------------------------------------------

export function parseChapterList(html: string, origin: string): RawChapter[] {
  const $ = cheerio.load(html);
  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  $("li.chapter a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href) return;

    const url = toAbsoluteUrl(href, origin);
    const text = $(el).text().trim();
    const number = extractChapterNumber(text);
    if (isNaN(number) || seen.has(number)) return;
    seen.add(number);

    chapters.push({ url, number });
  });

  return chapters;
}

// ---------------------------------------------------------------------------
// extractChapterId
//
// Extracts the numeric CHAPTER_ID from an inline <script> block on the chapter
// page. The liliana theme emits:
//   var CHAPTER_ID = 78093;
// ---------------------------------------------------------------------------

const CHAPTER_ID_RE = /(?:var|const|let)\s+CHAPTER_ID\s*=\s*(\d+)/;

export function extractChapterId(html: string): number | null {
  const match = CHAPTER_ID_RE.exec(html);
  if (!match || !match[1]) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// parseImageListResponse
//
// Parses the JSON response from GET /ajax/image/list/chap/<CHAPTER_ID>.
//
// Response shape: { "status": true, "html": "<div>...<img src='CDN_URL' ...></div>" }
//
// IMPORTANT: In the liliana theme, src= is the REAL CDN URL and data-src= is
// the lazy-loading placeholder (opposite of the lazysizes convention). Use src.
//
// Images are served in arbitrary order by the server and sorted client-side via
// a script that reads data-index. We sort by data-index to match reading order.
// ---------------------------------------------------------------------------

export interface ImageListResponse {
  status: boolean;
  html: string;
  msg?: string;
}

export function parseImageListResponse(json: ImageListResponse): string[] {
  if (!json.status || !json.html) return [];

  const $ = cheerio.load(json.html);

  const entries: Array<{ index: number; url: string }> = [];

  $("img[src]").each((_i, el) => {
    // src= is the real CDN URL; data-src= is the loading placeholder.
    const src = ($(el).attr("src") ?? "").trim();
    if (!src || !src.startsWith("http")) return;

    // Parse data-index for correct reading order. Fall back to DOM order.
    const rawIndex = $(el).closest("[data-index]").attr("data-index") ?? "";
    const index = rawIndex !== "" ? parseInt(rawIndex, 10) : entries.length;

    entries.push({ index: isNaN(index) ? entries.length : index, url: src });
  });

  entries.sort((a, b) => a.index - b.index);
  return entries.map((e) => e.url);
}

// ---------------------------------------------------------------------------
// extractChapterNumber
//
// Regex extraction from chapter link text.
//
// Handles:
//   "Chapter 0"       → 0
//   "Chapter 1"       → 1
//   "Chapter 01"      → 1
//   "Ch. 1.5"         → 1.5
//   "Chapter 03 - Title" → 3
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

export class LilianaParseError extends Error {
  override readonly name = "LilianaParseError";
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// parseManhuaPlusSearch
//
// Parses the JSON response from POST /ajax/search.
//
// Response shape: { "list": [{ "name": string, "url": string, "cover": string }], ... }
// The `url` field is already absolute; `cover` is a relative path.
// ---------------------------------------------------------------------------

const MP_ORIGIN = "https://manhuaplus.org";

interface MpHit { name?: string; url?: string; cover?: string; }

export function parseManhuaPlusSearch(body: string): SeriesSearchResult[] {
  const json = JSON.parse(body) as { list?: MpHit[] };
  return (json.list ?? [])
    .filter((h): h is MpHit & { name: string; url: string } => Boolean(h.name && h.url))
    .map((h) => ({
      adapterId: "manhuaplus" as const,
      title: h.name.trim(),
      seriesUrl: h.url.startsWith("http") ? h.url : `${MP_ORIGIN}${h.url}`,
      coverUrl: h.cover ? (h.cover.startsWith("http") ? h.cover : `${MP_ORIGIN}${h.cover}`) : null,
      coverReferer: `${MP_ORIGIN}/`,
    }));
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function toAbsoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(href, base).toString();
}
