// ---------------------------------------------------------------------------
// hivetoons.ts — SourceAdapter implementation for hivetoons.org
//
// Implements resolveSeries(), enumerateChapters(), parseChapterImages(), and
// NSFW bypass behaviour. Uses helpers in hivetoons.helpers.ts for parsing.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  ResolvedSeries,
  PageStub,
} from "../core/types.js";
import {
  parseSeriesPage,
  parseChapterPage,
  extractImageArrayFromScript,
  HivetoonsParseError,
} from "./hivetoons.helpers.js";

const SOURCE_ID = "hivetoons" as const;
const PRIMARY_HOST = "hivetoons.org";
const ORIGIN = "https://hivetoons.org";
const ORIGIN_WITH_SLASH = "https://hivetoons.org/";

class HivetoonsAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;
  readonly displayName = "HiveToons";

  matchHost(host: string): boolean {
    return host.toLowerCase().replace(/^www\./, "") === PRIMARY_HOST;
  }

  domainAliases(): readonly string[] {
    return [];
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
    // No special NSFW cookies known; still provide a hook for future.

    const response = await ctx.http.get(seriesUrl, {
      referer: ORIGIN_WITH_SLASH,
      signal: ctx.signal,
    });

    let html = response.body;

    let meta;
    try {
      meta = parseSeriesPage(html, ORIGIN);
    } catch (err) {
      // If initial parse fails, attempt a browser-rendered fallback before
      // giving up — many sources serve CF interstitials or JS-only lists.
      try {
        ctx.logger.debug({ seriesUrl }, "resolveSeries: initial parse failed, trying browser.renderPage fallback");
        html = await ctx.browser.renderPage(seriesUrl, { waitForSelector: "a[href*='/chapter/']" });
        meta = parseSeriesPage(html, ORIGIN);
      } catch (err2) {
        if (err instanceof HivetoonsParseError) throw err;
        throw new HivetoonsParseError(`resolveSeries: failed to parse ${seriesUrl}: ${String(err)}`);
      }
    }

    // If the HTTP response looked like a Cloudflare/blocked page, or the
    // parsed chapter list is empty, attempt a browser-rendered reparse.
    if ((meta.chapters.length === 0) || (typeof (ctx.http as any).isCloudflareChallenged === "function" && (ctx.http as any).isCloudflareChallenged(response))) {
      try {
        ctx.logger.debug({ seriesUrl }, "resolveSeries: zero chapters or CF challenge detected; trying browser.renderPage fallback");
        const rendered = await ctx.browser.renderPage(seriesUrl, { waitForSelector: "a[href*='/chapter/']" });
        html = rendered;
        meta = parseSeriesPage(html, ORIGIN);
      } catch {
        // ignore and continue with whatever we have — the caller will see 0 chapters
      }
    }

    // DEBUG: if still zero chapters, write html to file for inspection
    if (meta.chapters.length === 0) {
      try {
        writeFileSync('/tmp/hivetoons-debug.html', html.slice(0, 50000));
        ctx.logger.debug("Wrote first 50KB of failed parse HTML to /tmp/hivetoons-debug.html");
      } catch (e) {
        ctx.logger.debug({ error: String(e) }, "Failed to write debug HTML");
      }
    }

    const rawChapters = meta.chapters.slice();
    rawChapters.sort((a, b) => a.number - b.number);

    const preEnumeratedChapters: ChapterStub[] = rawChapters.map((rc) => ({
      chapterNumber: rc.number,
      chapterTitle: rc.title ?? null,
      chapterUrl: rc.url,
    }));

    ctx.logger.debug({ event: "adapter.series.resolved", seriesUrl, title: meta.title, chapterCount: preEnumeratedChapters.length }, "adapter.series.resolved");

    return {
      seriesTitle: meta.title,
      coverUrl: meta.coverUrl,
      coverReferer: ORIGIN_WITH_SLASH,
      preEnumeratedChapters,
    };
  }

  async enumerateChapters(ctx: AdapterContext, series: ResolvedSeries): Promise<readonly ChapterStub[]> {
    if (series.preEnumeratedChapters && series.preEnumeratedChapters.length > 0) return series.preEnumeratedChapters;

    // series.seriesId is stored as `${adapter.id}:${seriesUrl}` by the pipeline.
    // Extract the original series URL if necessary before re-resolving.
    let seriesUrl = series.seriesId;
    const prefix = `${this.id}:`;
    if (seriesUrl.startsWith(prefix)) {
      seriesUrl = seriesUrl.slice(prefix.length);
    }

    const { preEnumeratedChapters } = await this.resolveSeries(ctx, seriesUrl);
    return preEnumeratedChapters ?? [];
  }

  async parseChapterImages(ctx: AdapterContext, chapter: ChapterStub, chapterHtml: string): Promise<readonly PageStub[]> {
    // Primary: DOM parse
    let urls = parseChapterPage(chapterHtml, chapter.chapterUrl);

    // Fallback: inline script array
    if ((!urls || urls.length === 0)) {
      const arr = extractImageArrayFromScript(chapterHtml);
      if (arr && arr.length > 0) urls = arr.map((u) => new URL(u, chapter.chapterUrl).toString());
    }

    // Fallback: render in browser
    if ((!urls || urls.length === 0)) {
      try {
        // Ask the browser to render the page; wait for at least one image to
        // appear to improve the chance client-side scripts have populated the DOM.
        const html = await ctx.browser.renderPage(chapter.chapterUrl, { waitForSelector: "img" });
        urls = parseChapterPage(html, chapter.chapterUrl);
      } catch {
        ctx.logger.warn({ chapterUrl: chapter.chapterUrl }, "parseChapterImages: browser render fallback failed");
      }
    }

    ctx.logger.debug({ event: "adapter.chapter.resolved", chapterUrl: chapter.chapterUrl, pageCount: urls.length }, "adapter.chapter.resolved");

    const referer = this.imageRefererFor(chapter);
    return urls.map((u, i) => ({ pageIndex: i + 1, imageUrl: u, referer }));
  }

  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  async dismissNsfwSplash(_ctx: AdapterContext, _url: string): Promise<void> {
    // No-op for now. Implement cookie setting here if hivetoons introduces an age-gate.
    return;
  }
}

export const hivetoonsAdapter: SourceAdapter = new HivetoonsAdapter();

// Re-export parse error for callers that might want to catch it
export { HivetoonsParseError } from "./hivetoons.helpers.js";






