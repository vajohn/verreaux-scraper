// ---------------------------------------------------------------------------
// qimanhwa.ts — SourceAdapter for qimanhwa.com (Angular SSR SPA).
//
// qimanhwa is blocked locally by Zscaler and fronted by Cloudflare. It is
// scraped from a GitHub Actions runner (off-network) where the headless
// BrowserPool clears Cloudflare. Each rendered page embeds an Angular
// TransferState blob (ng-state) carrying the site's REST API responses, so
// series metadata, the chapter list, and per-chapter image lists are all
// parsed from the rendered HTML — no separate API call required.
//
// Paywall: chapters with isFree:false / requiresPurchase:true are skipped.
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
  extractNgState,
  mapSeriesMeta,
  mapChapterList,
  mapChapterImages,
  parseQimangaSearch,
  QimanhwaParseError,
} from "./qimanhwa.helpers.js";

const SOURCE_ID = "qimanhwa" as const;
const PRIMARY_HOST = "qimanhwa.com";
/** Rebranded domain — search results are served under this host. */
const ALIAS_HOST = "qimanga.com";
const ORIGIN_WITH_SLASH = "https://qimanhwa.com/";
const RENDER_TIMEOUT_MS = 60_000;

function seriesSlugFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean); // ["series","<slug>",...]
  if (segs[0] !== "series" || !segs[1]) {
    throw new QimanhwaParseError(`qimanhwa: not a /series/<slug> url: ${url}`);
  }
  return segs[1];
}
function chapterSlugFromUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean); // ["series","<slug>","<chapterSlug>"]
  if (segs[0] !== "series" || !segs[1] || !segs[2]) {
    throw new QimanhwaParseError(`qimanhwa: not a /series/<slug>/<chapterSlug> url: ${url}`);
  }
  return segs[2];
}

class QimanhwaAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;
  readonly displayName = "Qimanga";

  matchHost(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^www\./, "");
    return normalized === PRIMARY_HOST || normalized === ALIAS_HOST;
  }

  domainAliases(): readonly string[] {
    return [ALIAS_HOST];
  }

  liveDomain(): string {
    return PRIMARY_HOST;
  }

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
    const slug = seriesSlugFromUrl(seriesUrl);
    const html = await ctx.browser.renderPage(seriesUrl, {
      waitForSelector: "script#ng-state",
      state: "attached",
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    const state = extractNgState(html);
    if (!state) {
      throw new QimanhwaParseError(`resolveSeries: no ng-state on ${seriesUrl}`);
    }

    const meta = mapSeriesMeta(state, slug);
    const { chapters, skippedLocked } = mapChapterList(state, slug);
    if (skippedLocked > 0) {
      ctx.logger.warn({ seriesUrl, skippedLocked }, "qimanhwa: skipped locked (paid) chapters");
    }

    const preEnumeratedChapters: ChapterStub[] = chapters.map((c) => ({
      chapterNumber: c.number,
      chapterTitle: null,
      chapterUrl: c.url,
    }));

    ctx.logger.debug(
      {
        event: "adapter.series.resolved",
        seriesUrl,
        title: meta.title,
        chapterCount: preEnumeratedChapters.length,
        skippedLocked,
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

  async enumerateChapters(
    ctx: AdapterContext,
    series: ResolvedSeries,
  ): Promise<readonly ChapterStub[]> {
    if (series.preEnumeratedChapters && series.preEnumeratedChapters.length > 0) {
      return series.preEnumeratedChapters;
    }
    // series.seriesId is stored as `${adapter.id}:${seriesUrl}` by the pipeline.
    // Strip the prefix to recover the original series URL before re-resolving.
    let seriesUrl = series.seriesId;
    const prefix = `${this.id}:`;
    if (seriesUrl.startsWith(prefix)) {
      seriesUrl = seriesUrl.slice(prefix.length);
    }
    const { preEnumeratedChapters } = await this.resolveSeries(ctx, seriesUrl);
    return preEnumeratedChapters ?? [];
  }

  async fetchChapter(args: {
    ctx: AdapterContext;
    chapter: ChapterStub;
    seriesUrl: string;
    signal: AbortSignal;
  }): Promise<{ statusCode: number; body: string }> {
    const { ctx, chapter } = args;
    const body = await ctx.browser.renderPage(chapter.chapterUrl, {
      waitForSelector: "script#ng-state",
      state: "attached",
      timeoutMs: RENDER_TIMEOUT_MS,
    });
    return { statusCode: 200, body };
  }

  async parseChapterImages(
    _ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    const state = extractNgState(chapterHtml);
    if (!state) {
      throw new QimanhwaParseError(`parseChapterImages: no ng-state for ${chapter.chapterUrl}`);
    }
    const slug = seriesSlugFromUrl(chapter.chapterUrl);
    const chapterSlug = chapterSlugFromUrl(chapter.chapterUrl);
    const referer = this.imageRefererFor(chapter);
    return mapChapterImages(state, slug, chapterSlug).map(
      (url, idx): PageStub => ({ pageIndex: idx + 1, imageUrl: url, referer }),
    );
  }

  imageRefererFor(_chapter: ChapterStub): string {
    return ORIGIN_WITH_SLASH;
  }

  async search(ctx: AdapterContext, query: string): Promise<readonly SeriesSearchResult[]> {
    const resp = await ctx.http.get(
      `https://api.qimanga.com/api/v1/series/search?q=${encodeURIComponent(query)}&perPage=20`,
      { referer: "https://qimanga.com/", signal: ctx.signal },
    );
    return parseQimangaSearch(resp.body);
  }

  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // No adult age-gate.
  }
}

export const qimanhwaAdapter: SourceAdapter = new QimanhwaAdapter();
export { QimanhwaAdapter };
export { QimanhwaParseError } from "./qimanhwa.helpers.js";
