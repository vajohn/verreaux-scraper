// manhwanex.ts — SourceAdapter for manhwanex.com (modern Madara/wp-manga).
// LiteSpeed, no Cloudflare: plain HttpClient. resolveSeries reads title/cover
// from the series page and the chapter list from the modern Madara endpoint
// POST {seriesUrl}ajax/chapters/. Reader pages are server-rendered (plain GET).
import type { SourceAdapter, AdapterContext, ChapterStub, ResolvedSeries, PageStub } from "../core/types.js";
import { parseSeriesMetadata, parseChapterList, parseReaderImages, ManhwanexParseError, type RawChapter } from "./manhwanex.helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = "manhwanex" as const;
const PRIMARY_HOST = "manhwanex.com";
const ORIGIN = "https://manhwanex.com";
const ORIGIN_WITH_SLASH = "https://manhwanex.com/";

// ---------------------------------------------------------------------------
// ManhwanexAdapter
// ---------------------------------------------------------------------------

class ManhwanexAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  matchHost(host: string): boolean {
    return host.toLowerCase().replace(/^www\./, "") === PRIMARY_HOST;
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
  //   1. GET the series page to extract title and cover via parseSeriesMetadata.
  //   2. POST {seriesUrl}ajax/chapters/ (modern Madara endpoint) to get the
  //      chapter list HTML fragment. The old admin-ajax.php endpoint is dead.
  //   3. Sort chapters ascending by number and return as preEnumeratedChapters.
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
    const resp = await ctx.http.get(seriesUrl, { referer: ORIGIN_WITH_SLASH, signal: ctx.signal });
    const meta = parseSeriesMetadata(resp.body);

    const base = seriesUrl.endsWith("/") ? seriesUrl : `${seriesUrl}/`;
    const ajaxUrl = `${base}ajax/chapters/`;
    const ajax = await ctx.http.post(ajaxUrl, { referer: seriesUrl, signal: ctx.signal });
    const rawChapters: RawChapter[] = parseChapterList(ajax.body, ORIGIN);

    if (rawChapters.length === 0) {
      ctx.logger.warn({ seriesUrl }, "manhwanex: ajax/chapters returned no chapters");
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
  // pre-enumerated list is absent, re-fetch via resolveSeries.
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
  // Reader pages are server-rendered — .reading-content img elements carry the
  // image URL in src (may have a leading space). No AJAX or JS execution needed.
  // -------------------------------------------------------------------------
  async parseChapterImages(
    _ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const referer = this.imageRefererFor(chapter);
    return parseReaderImages(chapterHtml).map((url, idx): PageStub => ({
      pageIndex: idx + 1,
      imageUrl: url,
      referer,
    }));
  }

  // -------------------------------------------------------------------------
  // imageRefererFor
  //
  // Images are served from cdn.manhwanex.com but the chapter URL is used as
  // referer to match what a browser would send.
  // -------------------------------------------------------------------------
  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  // -------------------------------------------------------------------------
  // dismissNsfwSplash
  //
  // manhwanex.com has no adult age-gate; nothing to do.
  // -------------------------------------------------------------------------
  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const manhwanexAdapter: SourceAdapter = new ManhwanexAdapter();
export { ManhwanexAdapter };
export { ManhwanexParseError } from "./manhwanex.helpers.js";
