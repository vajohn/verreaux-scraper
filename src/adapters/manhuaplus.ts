// ---------------------------------------------------------------------------
// manhuaplus.ts — SourceAdapter implementation for manhuaplus.org
//
// Theme: liliana (custom theme, post-Madara migration as of 2025-06).
//
// Key behaviours:
//   - resolveSeries() parses title, cover, and chapter list from server-rendered HTML.
//     Chapter list is in the DOM — no admin-ajax.php POST required.
//   - parseChapterImages() extracts CHAPTER_ID from chapter page HTML, then calls
//     GET /ajax/image/list/chap/<CHAPTER_ID> to get the JSON image list.
//   - NSFW bypass cookies set before every series fetch (§20 Q7 pass-through-all).
//   - imageRefererFor() returns the chapter URL (CDN requires chapter page referer).
// ---------------------------------------------------------------------------

import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  ResolvedSeries,
  PageStub,
} from "../core/types.js";
import {
  parseSeriesMetadata,
  parseChapterList,
  extractChapterId,
  parseImageListResponse,
  LilianaParseError,
} from "./manhuaplus.helpers.js";
import type { ImageListResponse } from "./manhuaplus.helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = "manhuaplus" as const;
const PRIMARY_HOST = "manhuaplus.org";
const ORIGIN = "https://manhuaplus.org";
const ORIGIN_WITH_SLASH = "https://manhuaplus.org/";

/**
 * Adult-content bypass cookies (§20 Q7 — pass-through-all).
 * Identical cookie names as the old Madara adapter — carry them forward.
 */
const NSFW_BYPASS_COOKIES = [
  { name: "wpmanga-adult-confirmed", value: "1" },
  { name: "mature-content-allow", value: "1" },
  { name: "age_verified", value: "true" },
] as const;

// ---------------------------------------------------------------------------
// ManhuaPlusAdapter
// ---------------------------------------------------------------------------

class ManhuaPlusAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  // -------------------------------------------------------------------------
  // matchHost
  // -------------------------------------------------------------------------
  matchHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^www\./, "");
    return normalized === PRIMARY_HOST;
  }

  // -------------------------------------------------------------------------
  // domainAliases
  // -------------------------------------------------------------------------
  domainAliases(): readonly string[] {
    return [];
  }

  // -------------------------------------------------------------------------
  // liveDomain — always manhuaplus.org (single canonical host).
  // -------------------------------------------------------------------------
  liveDomain(): string {
    return PRIMARY_HOST;
  }

  // -------------------------------------------------------------------------
  // resolveSeries
  //
  // Steps:
  //   1. Pre-set NSFW bypass cookies (idempotent).
  //   2. Fetch series HTML.
  //   3. Parse title, cover, and server-rendered chapter list via helpers.
  //   4. Return with pre-enumerated chapter stubs sorted ascending.
  // -------------------------------------------------------------------------
  async resolveSeries(
    ctx: AdapterContext,
    seriesUrl: string,
  ): Promise<{
    seriesTitle: string;
    coverUrl: string;
    coverReferer: string;
    postId?: string;
    preEnumeratedChapters?: readonly ChapterStub[];
  }> {
    await this.dismissNsfwSplash(ctx, seriesUrl);

    const response = await ctx.http.get(seriesUrl, {
      referer: ORIGIN_WITH_SLASH,
      signal: ctx.signal,
    });

    const html = response.body;

    let meta: { title: string; coverUrl: string };
    try {
      meta = parseSeriesMetadata(html);
    } catch (err) {
      if (err instanceof LilianaParseError) throw err;
      throw new LilianaParseError(
        `resolveSeries: failed to parse metadata from ${seriesUrl}: ${String(err)}`,
      );
    }

    const rawChapters = parseChapterList(html, ORIGIN);
    rawChapters.sort((a, b) => a.number - b.number);

    const preEnumeratedChapters: ChapterStub[] = rawChapters.map((rc) => ({
      chapterNumber: rc.number,
      chapterTitle: null,
      chapterUrl: rc.url,
    }));

    ctx.logger.debug(
      {
        event: "adapter.series.resolved",
        seriesUrl,
        title: meta.title,
        chapterCount: preEnumeratedChapters.length,
      },
      "adapter.series.resolved",
    );

    return {
      seriesTitle: meta.title,
      coverUrl: meta.coverUrl,
      coverReferer: ORIGIN_WITH_SLASH,
      preEnumeratedChapters,
    };
  }

  // -------------------------------------------------------------------------
  // enumerateChapters
  //
  // Chapters are pre-enumerated during resolveSeries. If for any reason the
  // pre-enumerated list is absent, re-fetch the series page.
  // -------------------------------------------------------------------------
  async enumerateChapters(
    ctx: AdapterContext,
    series: ResolvedSeries,
  ): Promise<readonly ChapterStub[]> {
    if (series.preEnumeratedChapters && series.preEnumeratedChapters.length > 0) {
      return series.preEnumeratedChapters;
    }

    const { preEnumeratedChapters } = await this.resolveSeries(ctx, series.seriesId);
    return preEnumeratedChapters ?? [];
  }

  // -------------------------------------------------------------------------
  // parseChapterImages
  //
  // Receives the already-fetched chapter HTML from the pipeline.
  // Steps:
  //   1. Extract CHAPTER_ID from inline <script> in the HTML.
  //   2. GET /ajax/image/list/chap/<CHAPTER_ID> with required headers.
  //   3. Parse the JSON response's `html` field for image URLs.
  //   4. Return PageStub[] in sorted reading order.
  // -------------------------------------------------------------------------
  async parseChapterImages(
    ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const chapterId = extractChapterId(chapterHtml);

    if (chapterId === null) {
      ctx.logger.warn(
        { chapterUrl: chapter.chapterUrl },
        "parseChapterImages: CHAPTER_ID not found in chapter HTML",
      );
      return [];
    }

    const imageListUrl = `${ORIGIN}/ajax/image/list/chap/${chapterId}`;

    const response = await ctx.http.get(imageListUrl, {
      referer: chapter.chapterUrl,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: ctx.signal,
    });

    let json: ImageListResponse;
    try {
      json = JSON.parse(response.body) as ImageListResponse;
    } catch {
      ctx.logger.warn(
        { chapterId, chapterUrl: chapter.chapterUrl },
        "parseChapterImages: failed to parse image-list JSON",
      );
      return [];
    }

    const imageUrls = parseImageListResponse(json);

    ctx.logger.debug(
      {
        event: "adapter.chapter.resolved",
        chapterUrl: chapter.chapterUrl,
        chapterId,
        pageCount: imageUrls.length,
      },
      "adapter.chapter.resolved",
    );

    const referer = this.imageRefererFor(chapter);
    return imageUrls.map(
      (url, idx): PageStub => ({
        pageIndex: idx + 1,
        imageUrl: url,
        referer,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // imageRefererFor
  //
  // The CDN (cdn.manhuaplus.cc) carries referrerpolicy="no-referrer" on its
  // images, so the chapter page URL is the appropriate referer to send when
  // fetching the image bytes — matching how the browser would behave.
  // -------------------------------------------------------------------------
  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  // -------------------------------------------------------------------------
  // dismissNsfwSplash
  //
  // §20 Q7 override: pass-through-all. Set bypass cookies so the NSFW age-gate
  // is never shown. Idempotent — safe to call multiple times.
  //
  // Cookies:
  //   wpmanga-adult-confirmed=1  — carried forward from Madara era
  //   mature-content-allow=1     — carried forward from Madara era
  //   age_verified=true          — carried forward from Madara era
  // -------------------------------------------------------------------------
  async dismissNsfwSplash(ctx: AdapterContext, _url: string): Promise<void> {
    const now = new Date().toISOString();
    const farFuture = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

    for (const cookie of NSFW_BYPASS_COOKIES) {
      ctx.cookies.set({
        host: PRIMARY_HOST,
        domain: PRIMARY_HOST,
        name: cookie.name,
        value: cookie.value,
        path: "/",
        expires: farFuture,
        secure: false,
        httpOnly: false,
        sameSite: "Lax",
        userAgent: "",
        harvestedAt: now,
        lastUsedAt: null,
      });
    }

    ctx.logger.debug(
      {
        event: "adapter.nsfw_splash.dismissed",
        cookies: NSFW_BYPASS_COOKIES.map((c) => c.name),
      },
      "NSFW bypass cookies set — §20 Q7 pass-through-all",
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const manhuaPlusAdapter: SourceAdapter = new ManhuaPlusAdapter();

// Re-export error for callers that need to catch it specifically
export { LilianaParseError } from "./manhuaplus.helpers.js";
