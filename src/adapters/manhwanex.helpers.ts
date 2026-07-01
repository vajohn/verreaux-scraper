// ---------------------------------------------------------------------------
// manhwanex.helpers.ts — pure parse helpers for manhwanex.com (Madara theme).
//
// Side-effect-free; cheerio only. manhwanex serves a standard Madara/wp-manga
// WordPress theme over LiteSpeed (no Cloudflare):
//   - Chapter list comes from the modern Madara endpoint POST {seriesUrl}ajax/chapters/.
//   - Reader page renders pages under .reading-content img (plain src; may have leading space).
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";
import type { SeriesSearchResult } from "../core/types.js";

export interface ManhwanexSeries {
  title: string;
  coverUrl: string;
}

export interface RawChapter {
  url: string;
  number: number;
}

export class ManhwanexParseError extends Error {
  override readonly name = "ManhwanexParseError";
}

// Title: .post-title h1 (Madara). Cover: .summary_image img (prefer data-src;
// Madara lazy-loads with data-src and a placeholder in src).
export function parseSeriesMetadata(html: string): ManhwanexSeries {
  const $ = cheerio.load(html);
  const title = $(".post-title h1").first().text().trim();
  if (!title) {
    throw new ManhwanexParseError(
      "parseSeriesMetadata: could not extract title — .post-title h1 not found",
    );
  }
  const $cover = $(".summary_image img").first();
  const coverUrl = ($cover.attr("data-src") ?? $cover.attr("src") ?? "").trim();
  return { title, coverUrl };
}

// Chapter list markup (Madara):
//   <li class="wp-manga-chapter"><a href="https://.../chapter-N/">Chapter N</a>...
// Newest-first in DOM order; caller sorts ascending.
export function parseChapterList(html: string, origin: string): RawChapter[] {
  const $ = cheerio.load(html);
  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  $("li.wp-manga-chapter a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || !/\/chapter-/i.test(href)) return;
    const url = toAbsoluteUrl(href, origin);
    const number = extractChapterNumber($(el).text());
    if (Number.isNaN(number) || seen.has(number)) return;
    seen.add(number);
    chapters.push({ url, number });
  });

  return chapters;
}

// Reader images: .reading-content img, preferring data-src (lazy-load) over src.
export function parseReaderImages(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $(".reading-content img").each((_i, el) => {
    const $img = $(el);
    const u = ($img.attr("data-src") ?? $img.attr("src") ?? "").trim();
    if (u) urls.push(u);
  });
  return urls;
}

export function extractChapterNumber(linkText: string): number {
  const m = /(?:chapter|ch\.?)\s*([\d]+(?:\.[\d]+)?)/i.exec(linkText);
  if (m?.[1]) return parseFloat(m[1]);
  const f = /\b(\d+(?:\.\d+)?)\b/.exec(linkText);
  if (f?.[1]) return parseFloat(f[1]);
  return NaN;
}

function toAbsoluteUrl(href: string, origin: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = origin.endsWith("/") ? origin : `${origin}/`;
  return new URL(href, base).toString();
}

// ---------------------------------------------------------------------------
// parseManhwanexSearch
//
// Parses the JSON response from the Madara wp-manga-search-manga endpoint:
//   POST https://manhwanex.com/wp-admin/admin-ajax.php
//   body: action=wp-manga-search-manga&title=<query>
//
// Response shape: { "success": true, "data": [ { "title": "...", "url": "...", "type": "manga" } ] }
// There is no cover URL in the response.
// ---------------------------------------------------------------------------

interface MnxHit { title?: string; url?: string; }

export function parseManhwanexSearch(body: string): SeriesSearchResult[] {
  const json = JSON.parse(body) as { success?: boolean; data?: MnxHit[] };
  return (json.data ?? [])
    .filter((h): h is MnxHit & { title: string; url: string } => Boolean(h.title && h.url))
    .map((h) => ({
      adapterId: "manhwanex" as const,
      title: h.title.trim(),
      seriesUrl: h.url,               // absolute, e.g. https://manhwanex.com/manga/<slug>/
      coverUrl: null,                 // wp-manga-search-manga returns no cover
      coverReferer: "https://manhwanex.com/",
    }));
}
