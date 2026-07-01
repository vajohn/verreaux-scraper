// ---------------------------------------------------------------------------
// arenascan.ts — SourceAdapter implementation for arenascan.com
//
// Theme: WordPress MangaReader (Themesia).
//
// Key behaviours:
//   - resolveSeries() parses title, cover, and chapter list from server-rendered HTML.
//     Chapter list is in the DOM under #chapterlist li[data-num] — no AJAX required.
//   - parseChapterImages() extracts the inline `ts_reader.run({...})` JSON literal
//     and returns sources[0].images directly. No AJAX call needed.
//   - NSFW splash is a no-op: arenascan.com has no adult age-gate.
//   - imageRefererFor() returns the chapter URL (CDN images load relative to the
//     chapter page in a browser, so this matches the browser's behaviour).
// ---------------------------------------------------------------------------

import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  ResolvedSeries,
  PageStub,
  SeriesSearchResult,
} from "../core/types.js";
import {
  parseSeriesMetadata,
  parseChapterList,
  extractTsReaderConfig,
  pickImageList,
  parseThemesiaSearch,
  ArenascanParseError,
} from "./arenascan.helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = "arenascan" as const;
const PRIMARY_HOST = "arenascan.com";
const ORIGIN = "https://arenascan.com";
const ORIGIN_WITH_SLASH = "https://arenascan.com/";

// ---------------------------------------------------------------------------
// ArenascanAdapter
// ---------------------------------------------------------------------------

class ArenascanAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;
  readonly displayName = "ArenaScan";

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
  //   1. Fetch series HTML.
  //   2. Parse title, cover, and server-rendered chapter list via helpers.
  //   3. Return with pre-enumerated chapter stubs sorted ascending.
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

    const html = response.body;

    let meta: { title: string; coverUrl: string };
    try {
      meta = parseSeriesMetadata(html);
    } catch (err) {
      if (err instanceof ArenascanParseError) throw err;
      throw new ArenascanParseError(
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
  // Receives the already-fetched chapter HTML from the pipeline. The reader
  // page emits a single inline `ts_reader.run({...})` call whose JSON literal
  // carries the full image list. No AJAX call required.
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
  // cdn.arenascan.com images are loaded from the chapter page in a browser,
  // so the chapter URL is the appropriate referer to send.
  // -------------------------------------------------------------------------
  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  // -------------------------------------------------------------------------
  // search
  //
  // Themesia live-search AJAX endpoint. POSTs to wp-admin/admin-ajax.php with
  // action=ts_ac_do_search and returns matching series stubs.
  // -------------------------------------------------------------------------
  async search(ctx: AdapterContext, query: string): Promise<readonly SeriesSearchResult[]> {
    const resp = await ctx.http.post(`${ORIGIN}/wp-admin/admin-ajax.php`, {
      referer: ORIGIN_WITH_SLASH,
      signal: ctx.signal,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
      body: `action=ts_ac_do_search&ts_ac_query=${encodeURIComponent(query)}`,
    });
    return parseThemesiaSearch(this.id, resp.body);
  }

  // -------------------------------------------------------------------------
  // dismissNsfwSplash
  //
  // arenascan.com has no adult age-gate; nothing to do.
  // -------------------------------------------------------------------------
  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const arenascanAdapter: SourceAdapter = new ArenascanAdapter();
export { ArenascanAdapter };
export { ArenascanParseError } from "./arenascan.helpers.js";
