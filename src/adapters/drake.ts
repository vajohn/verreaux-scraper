// ---------------------------------------------------------------------------
// drake.ts — SourceAdapter implementation for drakecomic.org (Drake Scans).
//
// Theme: WordPress MangaReader (Themesia). Structurally identical to the
// arenascan adapter; the only fixture-driven divergence is the cover selector
// (drake's og:image is the site logo, so we read div.thumb img instead).
//
// Key behaviours:
//   - resolveSeries() parses title, cover, and chapter list from server-rendered HTML.
//     Chapter list is in the DOM under #chapterlist li[data-num] — no AJAX required.
//   - parseChapterImages() extracts the inline `ts_reader.run({...})` JSON literal
//     and returns the chosen source's images directly. No AJAX call needed.
//   - NSFW splash is a no-op: drakecomic.org has no adult age-gate.
//   - imageRefererFor() returns the chapter URL so wp-content/uploads images
//     load with the same referer a browser would send.
//
// Cloudflare note: the live site sits behind Turnstile, so production traffic
// must reach the page via the Playwright transport which already handles the
// challenge. Parsers in this file operate on captured HTML.
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
  extractTsReaderConfig,
  pickImageList,
  DrakeParseError,
  type RawChapter,
  type SeriesMetadata,
} from "./drake.helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = "drake" as const;
const PRIMARY_HOST = "drakecomic.org";
const ORIGIN = "https://drakecomic.org";
const ORIGIN_WITH_SLASH = "https://drakecomic.org/";

// ---------------------------------------------------------------------------
// DrakeAdapter
// ---------------------------------------------------------------------------

class DrakeAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  matchHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^www\./, "");
    return normalized === PRIMARY_HOST;
  }

  domainAliases(): readonly string[] {
    return [];
  }

  liveDomain(): string {
    return PRIMARY_HOST;
  }

  // -------------------------------------------------------------------------
  // resolveSeries
  //
  // Steps:
  //   1. Fetch series HTML via got.
  //   2. Parse title, cover, and server-rendered chapter list via helpers.
  //   3. If the static HTML is missing h1.entry-title or yields zero chapters,
  //      fall back to ctx.browser.renderPage so the per-host BrowserContext's
  //      cf_clearance + matching UA are used (Cloudflare's clearance cookie is
  //      bound to the harvesting UA, so got often gets a re-challenge body).
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
    const response = await ctx.http.get(seriesUrl, {
      referer: ORIGIN_WITH_SLASH,
      signal: ctx.signal,
    });

    let html = response.body;
    let { meta, rawChapters } = tryParseSeries(html);

    if (meta === null || rawChapters.length === 0) {
      ctx.logger.warn(
        {
          seriesUrl,
          reason: meta === null ? "no_title" : "zero_chapters",
        },
        "resolveSeries: static HTML insufficient; falling back to renderPage",
      );
      html = await ctx.browser.renderPage(seriesUrl, {
        waitForSelector: "#chapterlist li",
        state: "attached",
        // Long enough for a human to solve a Cloudflare Turnstile challenge
        // in the visible browser window (requires --allow-headed-cloudflare).
        timeoutMs: 180_000,
      });
      ({ meta, rawChapters } = tryParseSeries(html));
    }

    if (meta === null) {
      throw new DrakeParseError(
        `resolveSeries: could not extract title from ${seriesUrl} after browser render. ` +
          `drakecomic.org sits behind Cloudflare Turnstile — re-run with --allow-headed-cloudflare ` +
          `and solve the challenge in the browser window when it appears.`,
      );
    }

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
  // fetchChapter
  //
  // Routes chapter HTML retrieval through the per-host BrowserContext so the
  // cf_clearance harvested for the series page is reused. The default
  // http.get-based pipeline gets re-challenged because cf_clearance is UA-bound
  // to the Playwright browser, not got.
  // -------------------------------------------------------------------------
  async fetchChapter(args: {
    ctx: AdapterContext;
    chapter: ChapterStub;
    seriesUrl: string;
    signal: AbortSignal;
  }): Promise<{ statusCode: number; body: string }> {
    const { ctx, chapter } = args;
    const body = await ctx.browser.renderPage(chapter.chapterUrl, {
      waitForSelector: "#readerarea img, script:not([src])",
      state: "attached",
      timeoutMs: 180_000,
    });
    return { statusCode: 200, body };
  }

  // -------------------------------------------------------------------------
  // parseChapterImages
  //
  // The reader page emits a single inline `ts_reader.run({...})` call whose
  // JSON literal carries the full image list. fetchChapter already renders via
  // the per-host BrowserContext so the inline script is reliably present.
  // -------------------------------------------------------------------------
  async parseChapterImages(
    ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const cfg = extractTsReaderConfig(chapterHtml);

    if (cfg === null) {
      ctx.logger.warn(
        { chapterUrl: chapter.chapterUrl },
        "parseChapterImages: ts_reader.run config not found in chapter HTML",
      );
      return [];
    }

    const imageUrls = pickImageList(cfg);

    ctx.logger.debug(
      {
        event: "adapter.chapter.resolved",
        chapterUrl: chapter.chapterUrl,
        postId: cfg.post_id,
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
  // Reader images are served from drakecomic.org/wp-content/uploads/... so the
  // chapter page URL is the appropriate referer.
  // -------------------------------------------------------------------------
  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  // -------------------------------------------------------------------------
  // fetchImage
  //
  // Images live under drakecomic.org/wp-content/uploads/, same origin as the
  // CF-gated reader. We route the fetch through the per-host BrowserContext so
  // the cf_clearance harvested by renderPage is reused with the matching UA.
  // The default HttpClient path would receive an HTML challenge body and fail
  // image-format validation.
  // -------------------------------------------------------------------------
  async fetchImage(args: {
    ctx: AdapterContext;
    url: string;
    referer: string;
    signal: AbortSignal;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }> {
    const { ctx, url, referer } = args;
    const resp = await ctx.browser.fetchBuffer(url, { referer });
    return {
      statusCode: resp.statusCode,
      headers: resp.headers,
      body: resp.body,
    };
  }

  // -------------------------------------------------------------------------
  // dismissNsfwSplash
  //
  // drakecomic.org has no adult age-gate; nothing to do.
  // -------------------------------------------------------------------------
  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run the static-HTML parsers and collapse missing-title errors into a null
 * meta. Lets the caller decide whether to escalate to a browser render.
 */
function tryParseSeries(html: string): {
  meta: SeriesMetadata | null;
  rawChapters: RawChapter[];
} {
  let meta: SeriesMetadata | null = null;
  try {
    meta = parseSeriesMetadata(html);
  } catch (err) {
    if (!(err instanceof DrakeParseError)) throw err;
  }
  const rawChapters = parseChapterList(html, ORIGIN);
  return { meta, rawChapters };
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const drakeAdapter: SourceAdapter = new DrakeAdapter();
export { DrakeAdapter };
export { DrakeParseError } from "./drake.helpers.js";
