// ---------------------------------------------------------------------------
// asurascans.helpers.ts — pure functions for AsuraScans HTML/JSON parsing.
//
// No side effects, no HTTP, no global state.  Every function is independently
// testable against fixture data.
//
// §15.1: series page parse, image extraction, slug/hash handling.
//
// Stack: Astro v5.16.8 (server-rendered, no __NEXT_DATA__).
// CDN:   cdn.asurascans.com
// URLs:  /comics/<slug>-<hash>/chapter/<n>
// ---------------------------------------------------------------------------

import * as cheerio from "cheerio";
import type { SeriesSearchResult } from "../core/types.js";

// ---------------------------------------------------------------------------
// Error types
//
// NextDataNotFoundError is kept for API compatibility: cli.errorMap.ts maps it
// to SOURCE_NOT_FOUND (exit 4).  We repurpose it as a generic "page parse
// failed" signal when the Astro page structure is missing.
// ---------------------------------------------------------------------------

export class NextDataNotFoundError extends Error {
  override readonly name = "NextDataNotFoundError";
  constructor(message = "AsuraScans page structure not recognised (expected Astro v5 series page)") {
    super(message);
  }
}

export class SlugParseError extends Error {
  override readonly name = "SlugParseError";
  constructor(input: string) {
    super(
      `Cannot parse slug+hash from path "${input}". ` +
      `Expected format: /comics/<slug>-<hash6-12> where hash is [a-f0-9]{6,12}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// RawChapter — intermediate shape returned by parseSeriesPage before
// normalisation into ChapterStub.
// ---------------------------------------------------------------------------

export interface RawChapter {
  /** Chapter number as found in the HTML */
  chapterNumber: number;
  /** Optional chapter title */
  chapterTitle: string | null;
  /** Slug fragment, e.g. "chapter-83" */
  chapterSlug: string | null;
}

// ---------------------------------------------------------------------------
// parseSlugAndHash — extract slug and hash from a series or chapter URL path.
//
// Accepts /comics/, /series/, /manga/, /manhua/ prefixes.
//
// Examples:
//   /comics/the-max-level-players-100th-regression-030ff47a
//   /series/the-max-level-players-100th-regression-030ff47a
//   → { slug: 'the-max-level-players-100th-regression', hash: '030ff47a' }
//
// Throws SlugParseError on mismatch.
// ---------------------------------------------------------------------------

const SLUG_HASH_RE =
  /^\/(?:series|comics|manga|manhua)\/(?<slug>[a-z0-9][a-z0-9-]*)-(?<hash>[a-f0-9]{6,12})(?:\/.*)?$/;

export function parseSlugAndHash(seriesUrl: string): { slug: string; hash: string } {
  let pathname: string;
  try {
    pathname = new URL(seriesUrl).pathname;
  } catch {
    pathname = seriesUrl;
  }

  const match = SLUG_HASH_RE.exec(pathname);
  if (!match || !match.groups) {
    throw new SlugParseError(pathname);
  }

  const { slug, hash } = match.groups as { slug: string; hash: string };
  return { slug, hash };
}

// ---------------------------------------------------------------------------
// buildChapterUrl — construct the canonical chapter URL.
//
// Format: https://<liveDomain>/comics/<slug>-<hash>/chapter/<n>
// ---------------------------------------------------------------------------

export function buildChapterUrl(
  liveDomain: string,
  slug: string,
  hash: string,
  chapter: number,
): string {
  const chapterStr = Number.isInteger(chapter)
    ? String(chapter)
    : String(chapter);
  return `https://${liveDomain}/comics/${slug}-${hash}/chapter/${chapterStr}`;
}

// ---------------------------------------------------------------------------
// parseSeriesPage — cheerio-based parse of the Astro series page.
//
// Primary strategy: scan <a href="/comics/<slug>-<hash>/chapter/<N>"> links
// to build the chapter list.  The links appear in newest-first order in the
// HTML; the caller must sort ascending by chapterNumber.
//
// Fallback strategy: decode the Astro island props blob (Island 13 pattern)
// which contains a full chapters array with chapter numbers and slugs.
//
// Returns:
//   title      — from <h1> or <title> or og:title meta
//   coverUrl   — from og:image meta (canonical, not thumbnail variant)
//   slug       — series slug without hash
//   hash       — 6-12 char hex hash
//   chapters   — RawChapter[], in source order (newest first from HTML)
// ---------------------------------------------------------------------------

export function parseSeriesPage(
  html: string,
  sourceUrl: string,
): {
  title: string;
  coverUrl: string | null;
  slug: string;
  hash: string;
  chapters: RawChapter[];
} {
  const $ = cheerio.load(html);

  // --- Title ---
  // Prefer the h1 inside the article card.
  let title = $("h1").first().text().trim();
  if (!title) {
    // Fallback to og:title or <title>
    title =
      $("meta[property='og:title']").attr("content")?.replace(/\s*\|\s*.*$/, "").trim() ??
      $("title").text().replace(/\s*\|\s*.*$/, "").trim();
  }

  // --- Cover URL ---
  // og:image is the canonical full-size cover.
  const coverUrl =
    $("meta[property='og:image']").attr("content")?.trim() ?? null;

  // --- Slug + Hash from source URL ---
  let slug = "";
  let hash = "";
  try {
    const parsed = parseSlugAndHash(sourceUrl);
    slug = parsed.slug;
    hash = parsed.hash;
  } catch {
    // sourceUrl may be unresolvable — try to parse from canonical link in HTML.
    const canonical = $("link[rel='canonical']").attr("href") ?? "";
    try {
      const parsed = parseSlugAndHash(canonical);
      slug = parsed.slug;
      hash = parsed.hash;
    } catch { /* leave empty */ }
  }

  // --- Chapter list ---
  // Primary: anchor links of the form /comics/<slug>-<hash>/chapter/<N>
  // These appear in newest-first order in the HTML chapter list section.
  const chapters = parseChapterLinksFromSeriesHtml($, html, slug, hash);

  // Fallback: Astro island props blob if DOM scan returned nothing.
  if (chapters.length === 0) {
    const fromAstro = parseChaptersFromAstroIsland(html);
    return { title, coverUrl, slug, hash, chapters: fromAstro };
  }

  return { title, coverUrl, slug, hash, chapters };
}

// ---------------------------------------------------------------------------
// parseChapterLinksFromSeriesHtml — internal helper: scan anchor tags.
// ---------------------------------------------------------------------------

function parseChapterLinksFromSeriesHtml(
  $: ReturnType<typeof cheerio.load>,
  html: string,
  slug: string,
  hash: string,
): RawChapter[] {
  const seen = new Set<number>();
  const chapters: RawChapter[] = [];

  // Build a pattern that matches any /comics/<slug>-<hash>/chapter/<N> link.
  // When slug/hash are known, be precise; when unknown, be liberal.
  const CHAPTER_HREF_RE = (slug && hash)
    ? new RegExp(`^/comics/${escapeRegExp(slug)}-${hash}/chapter/(\\d+(?:\\.\\d+)?)$`)
    : /^\/comics\/[^/]+-[a-f0-9]{6,12}\/chapter\/(\d+(?:\.\d+)?)$/;

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const m = CHAPTER_HREF_RE.exec(href);
    if (!m) return;

    const chapterNumber = parseFloat(m[1]!);
    if (isNaN(chapterNumber) || seen.has(chapterNumber)) return;
    seen.add(chapterNumber);

    // Try to extract a chapter title from the link text or sibling spans.
    let chapterTitle: string | null = null;
    const linkText = $(el).text().trim();
    // Strip leading "Chapter N" to get optional subtitle.
    const titleMatch = /Chapter\s+\d+(?:\.\d+)?\s*[-–]?\s*(.+)/i.exec(linkText);
    if (titleMatch && titleMatch[1] && titleMatch[1].trim()) {
      chapterTitle = titleMatch[1].trim();
    }
    // Look for a sibling <span> with a subtitle (common in Astro layout).
    if (!chapterTitle) {
      const siblingSpan = $(el).find("span.block, span.truncate").last().text().trim();
      if (siblingSpan && !/^chapter\s+\d/i.test(siblingSpan)) {
        chapterTitle = siblingSpan || null;
      }
    }

    chapters.push({
      chapterNumber,
      chapterTitle: chapterTitle ?? null,
      chapterSlug: `chapter-${m[1]}`,
    });
  });

  return chapters;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// parseChaptersFromAstroIsland — fallback: decode the Astro island props blob
// for the chapter list island (the one with "chapters" + "seriesSlug" keys).
//
// The blob is HTML-entity-encoded JSON using Astro's [type, value] encoding:
//   [0, value] = scalar
//   [1, [items]] = array
// ---------------------------------------------------------------------------

function parseChaptersFromAstroIsland(html: string): RawChapter[] {
  // The props attribute containing the chapter list island.
  // Pattern: props="...&quot;chapters&quot;:[1,[...]]..."
  // We search for the encoded form of `"chapters":[1,[` and extract the
  // enclosing props= attribute.
  const chaptersKeyEncoded = "&quot;chapters&quot;";
  const idx = html.indexOf(chaptersKeyEncoded);
  if (idx < 0) return [];

  // Find the enclosing props=" ... " attribute.
  const propsStart = html.lastIndexOf('props="', idx);
  if (propsStart < 0) return [];

  // Find the closing " — must handle that props value uses &quot; not raw "
  const valueStart = propsStart + 7; // length of 'props="'
  const propsEnd = html.indexOf('"', valueStart);
  if (propsEnd < 0) return [];

  const rawProps = html.slice(valueStart, propsEnd);

  // HTML-unescape: &quot; → "   &amp; → &   &#39; → '
  const decoded = rawProps
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return [];
  }

  if (!("chapters" in parsed)) return [];

  const chaptersVal = parsed["chapters"];
  // Astro format: [1, [[0, {...}], [0, {...}], ...]]
  if (!Array.isArray(chaptersVal) || chaptersVal[0] !== 1) return [];
  const inner = chaptersVal[1];
  if (!Array.isArray(inner)) return [];

  const chapters: RawChapter[] = [];
  const seen = new Set<number>();

  for (const item of inner) {
    if (!Array.isArray(item) || item[0] !== 0) continue;
    const entry = item[1] as Record<string, unknown>;
    if (!entry || typeof entry !== "object") continue;

    // number field: [0, N]
    const numField = entry["number"];
    if (!Array.isArray(numField)) continue;
    const chapterNumber = parseFloat(String(numField[1]));
    if (isNaN(chapterNumber) || seen.has(chapterNumber)) continue;
    seen.add(chapterNumber);

    // slug field: [0, "chapter-N"]
    const slugField = entry["slug"];
    const chapterSlug = Array.isArray(slugField) ? String(slugField[1]) : null;

    chapters.push({
      chapterNumber,
      chapterTitle: null,
      chapterSlug,
    });
  }

  return chapters;
}

// ---------------------------------------------------------------------------
// parseChapterPage — extract chapter image URLs from an Astro chapter page.
//
// Primary strategy: cheerio DOM scan for
//   img[src*="cdn.asurascans.com/asura-images/chapters/"]
// in document order.
//
// Fallback: extractAstroPageJson() when DOM scan returns 0 or suspicious results.
// ---------------------------------------------------------------------------

export function parseChapterPage(html: string): { imageUrls: string[] } {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const results: string[] = [];

  const CDN_CHAPTERS_RE = /cdn\.asurascans\.com\/asura-images\/chapters\//;

  function addUrl(src: string | undefined): void {
    if (!src) return;
    const trimmed = src.trim();
    if (!CDN_CHAPTERS_RE.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    results.push(trimmed);
  }

  // Primary: scan img tags — the page is server-rendered so images are in the DOM.
  // Try targeted containers first for isolation.
  const CONTAINER_SELECTORS = [
    '[class*="select-none"]',
    ".max-w-full",
    "main",
  ];

  let usedContainer = false;
  for (const sel of CONTAINER_SELECTORS) {
    const container = $(sel).first();
    if (container.length) {
      container.find("img").each((_i, el) => {
        addUrl($(el).attr("src") ?? $(el).attr("data-src"));
      });
      if (results.length > 0) {
        usedContainer = true;
        break;
      }
    }
  }

  if (!usedContainer || results.length === 0) {
    $("img").each((_i, el) => {
      addUrl($(el).attr("src") ?? $(el).attr("data-src"));
    });
  }

  // Fallback: if DOM scan found nothing (or only 1 image which might be the cover),
  // try the Astro hydration JSON blob.
  if (results.length <= 1) {
    const fromJson = extractAstroPageJson(html);
    if (fromJson && fromJson.length > results.length) {
      return { imageUrls: fromJson };
    }
  }

  return { imageUrls: results };
}

// ---------------------------------------------------------------------------
// extractAstroPageJson — defensive parse of the Astro island props blob on a
// chapter page.
//
// The blob contains a "pages" key structured as:
//   [1, [[0, {url: [0, "https://..."], width: [0, N], height: [0, N]}], ...]]
//
// Returns URLs in order, or null if the structure is absent / unrecognisable.
// ---------------------------------------------------------------------------

export function extractAstroPageJson(html: string): string[] | null {
  // The key is HTML-entity-encoded in the props attribute.
  const pagesKeyEncoded = "&quot;pages&quot;";
  const idx = html.indexOf(pagesKeyEncoded);
  if (idx < 0) return null;

  // Find the enclosing props=" ... " attribute.
  const propsStart = html.lastIndexOf('props="', idx);
  if (propsStart < 0) return null;

  const valueStart = propsStart + 7;
  const propsEnd = html.indexOf('"', valueStart);
  if (propsEnd < 0) return null;

  const rawProps = html.slice(valueStart, propsEnd);
  const decoded = rawProps
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!("pages" in parsed)) return null;

  const pagesVal = parsed["pages"];
  // Astro format: [1, [[0, {url: [0, "..."], width: [0, N], height: [0, N]}], ...]]
  if (!Array.isArray(pagesVal) || pagesVal[0] !== 1) return null;
  const inner = pagesVal[1];
  if (!Array.isArray(inner)) return null;

  const urls: string[] = [];
  for (const item of inner) {
    if (!Array.isArray(item) || item[0] !== 0) continue;
    const entry = item[1] as Record<string, unknown>;
    if (!entry || typeof entry !== "object") continue;

    const urlField = entry["url"];
    if (!Array.isArray(urlField) || typeof urlField[1] !== "string") continue;
    const url = urlField[1].trim();
    if (url) urls.push(url);
  }

  return urls.length > 0 ? urls : null;
}

// ---------------------------------------------------------------------------
// isNsfwSplash — heuristic: page is an NSFW/adult interstitial with no CDN
// chapter images.
//
// Updated CDN pattern for cdn.asurascans.com (post-migration).
// ---------------------------------------------------------------------------

const NSFW_MARKERS_RE =
  /mature\s+content|adult\s+content|click\s+to\s+continue|this\s+content\s+is\s+for\s+adults|age\s+verification|18\+\s+only|confirm\s+your\s+age|adult[-\s]confirmed|safe.?browse/i;

const CDN_IMAGE_RE =
  /cdn\.asurascans\.com|gg\.asuracomic\.net|cdn\.asuracomic\.net|gg\.asura/i;

export function isNsfwSplash(html: string): boolean {
  const hasSplashMarker = NSFW_MARKERS_RE.test(html);
  if (!hasSplashMarker) return false;
  const hasCdnImages = CDN_IMAGE_RE.test(html);
  return !hasCdnImages;
}

// ---------------------------------------------------------------------------
// parseAsuraSearch — parse the AsuraScans JSON search API response.
//
// Endpoint: https://api.asurascans.com/api/search?q=<query>
// Response: { data: [{ id, slug, title, cover, ... }], meta: { total, per_page } }
// ---------------------------------------------------------------------------

interface AsuraHit {
  slug?: string;
  title?: string;
  cover?: string;
}

export function parseAsuraSearch(body: string): SeriesSearchResult[] {
  const json = JSON.parse(body) as { data?: AsuraHit[] };
  return (json.data ?? [])
    .filter((h): h is AsuraHit & { slug: string; title: string } =>
      Boolean(h.slug && h.title),
    )
    .map((h) => ({
      adapterId: "asurascans" as const,
      title: h.title.trim(),
      seriesUrl: `https://asurascans.com/series/${h.slug}`,
      coverUrl: h.cover ?? null,
      coverReferer: "https://asurascans.com/",
    }));
}

// NextDataNotFoundError is already exported at the class declaration above.
// It is kept for cli.errorMap.ts compatibility (maps to SOURCE_NOT_FOUND exit 4).
