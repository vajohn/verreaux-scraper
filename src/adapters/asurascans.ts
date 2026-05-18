// ---------------------------------------------------------------------------
// asurascans.ts — SourceAdapter implementation for AsuraScans / AsuraComic.
//
// Stack: Astro v5.16.8 (server-rendered, no __NEXT_DATA__).
//
// Handles all three known hosts:
//   asurascans.com  (canonical as of 2026-05-16 — probe FIRST)
//   asuracomic.net  (historical primary, still resolves)
//   asuratoon.com   (historical alias)
//
// Key behaviours:
//   - liveDomain() probes in recency order; result cached for the run.
//   - resolveSeries() parses Astro server-rendered HTML for chapter list + meta.
//   - resolveChapter() extracts CDN image URLs via DOM scan + Astro JSON fallback.
//   - NSFW splash auto-dismissed (§20 Q7 OVERRIDE — never block on splash).
//   - Slug-mutation handler (§10): 404 on chapter → re-enumerate → retry.
//   - imageRefererFor() returns chapter URL — required for cdn.asurascans.com.
// ---------------------------------------------------------------------------

import type {
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  PageStub,
  ResolvedSeries,
} from "../core/types.js";
import {
  parseSeriesPage,
  parseChapterPage,
  parseSlugAndHash,
  buildChapterUrl,
  isNsfwSplash,
  extractAstroPageJson,
} from "./asurascans.helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = "asurascans" as const;

/**
 * Probe order: asurascans.com is the canonical live domain as of 2026-05-16.
 * Fall back to asuracomic.net then asuratoon.com.
 */
const DOMAIN_PROBE_ORDER = [
  "asurascans.com",
  "asuracomic.net",
  "asuratoon.com",
] as const;

const KNOWN_HOSTS = new Set<string>(DOMAIN_PROBE_ORDER);

/** All URL path prefixes accepted by matchHost (checked at the URL level). */
const KNOWN_PATH_PREFIXES = ["/comics/", "/series/", "/manga/", "/manhua/"];

/** CDN host patterns for cdn.asurascans.com chapter images. */
const CDN_CHAPTERS_PATTERN = /cdn\.asurascans\.com\/asura-images\/chapters\//i;

/** Cookies required to pass NSFW splash (§20 Q7). */
const NSFW_BYPASS_COOKIES: ReadonlyArray<{ name: string; value: string }> = [
  { name: "safe_browse", value: "0" },
  { name: "_adult_confirmed", value: "1" },
  { name: "wpmanga-adult-confirmed", value: "1" },
];

// ---------------------------------------------------------------------------
// Typed error for slug-mutation failures
// ---------------------------------------------------------------------------

export class SlugMutationUnrecoverableError extends Error {
  override readonly name = "SlugMutationUnrecoverableError";
  constructor(
    readonly chapterNumber: number,
    readonly oldUrl: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// AsuraScansAdapter
// ---------------------------------------------------------------------------

export class AsuraScansAdapter implements SourceAdapter {
  readonly id = SOURCE_ID;

  /** Cached live domain — set on first resolveLiveDomain() call. */
  private cachedLiveDomain: string | null = null;

  /** Cached chapter list for slug-mutation re-enumeration.
   *  Key: original series URL. */
  private cachedChapterList: Map<string, ChapterStub[]> = new Map();

  // -------------------------------------------------------------------------
  // SourceAdapter interface
  // -------------------------------------------------------------------------

  matchHost(host: string): boolean {
    const normalised = host.toLowerCase().replace(/^www\./, "");
    return KNOWN_HOSTS.has(normalised);
  }

  domainAliases(): readonly string[] {
    return [...DOMAIN_PROBE_ORDER];
  }

  liveDomain(): string {
    return this.cachedLiveDomain ?? DOMAIN_PROBE_ORDER[0];
  }

  // -------------------------------------------------------------------------
  // resolveLiveDomain — probe each domain, cache first live one.
  // -------------------------------------------------------------------------
  async resolveLiveDomain(ctx: AdapterContext): Promise<string> {
    if (this.cachedLiveDomain) return this.cachedLiveDomain;

    const start = Date.now();

    for (const domain of DOMAIN_PROBE_ORDER) {
      try {
        const resp = await ctx.http.get(`https://${domain}/`, {
          signal: ctx.signal,
        });
        const status = resp.statusCode;
        const isLive = status < 500 || ctx.http.isCloudflareChallenged(resp);

        if (isLive) {
          this.cachedLiveDomain = domain;
          ctx.logger.info(
            { domain, status },
            `adapter.live_domain.resolved: ${domain}`,
          );
          (ctx as unknown as { eventBus?: { emit: Function } }).eventBus?.emit(
            "adapter.live_domain.resolved",
            {
              source: SOURCE_ID,
              domain,
              probeOrderMs: Date.now() - start,
            },
          );
          return domain;
        }
      } catch {
        // Domain dead or unreachable — try next.
      }
    }

    // All probes failed — fall back to the canonical domain without emitting.
    this.cachedLiveDomain = DOMAIN_PROBE_ORDER[0];
    return this.cachedLiveDomain;
  }

  // -------------------------------------------------------------------------
  // resolveSeries — fetch series page, parse via parseSeriesPage, return
  // series info with pre-enumerated chapter list.
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
    const live = await this.resolveLiveDomain(ctx);
    const canonical = this.rewriteHostToLiveDomain(seriesUrl, live);

    let html = await this.fetchHtml(ctx, canonical);

    // Parse slug + hash from URL.
    let slugInfo: { slug: string; hash: string };
    try {
      slugInfo = parseSlugAndHash(canonical);
    } catch {
      slugInfo = { slug: "", hash: "" };
    }

    // Parse the Astro server-rendered series page.
    const parsed = parseSeriesPage(html, canonical);

    // If slug/hash came out empty from parseSeriesPage, use what we got from URL.
    const slug = parsed.slug || slugInfo.slug;
    const hash = parsed.hash || slugInfo.hash;

    // Build ChapterStub list sorted ascending (§spec Q4).
    // parseSeriesPage returns chapters in source order (newest first) — sort.
    const chapters: ChapterStub[] = parsed.chapters
      .filter((rc) => !isNaN(rc.chapterNumber))
      .map((rc): ChapterStub => {
        const chapterUrl = buildChapterUrl(
          live,
          slug || "unknown",
          hash || "000000",
          rc.chapterNumber,
        );
        return {
          chapterNumber: rc.chapterNumber,
          chapterTitle: rc.chapterTitle,
          chapterUrl,
        };
      })
      .sort((a, b) => a.chapterNumber - b.chapterNumber);

    // If zero chapters parsed and Playwright is available, try hydrated render.
    if (chapters.length === 0) {
      ctx.logger.warn(
        { url: canonical },
        "Zero chapters from static HTML; falling back to renderPage",
      );
      html = await ctx.browser.renderPage(canonical, {
        waitForSelector: 'a[href*="/chapter/"]',
        state: "attached",
        timeoutMs: 10_000,
      });
      const reparsed = parseSeriesPage(html, canonical);
      const reSlug = reparsed.slug || slug;
      const reHash = reparsed.hash || hash;
      const rechapters: ChapterStub[] = reparsed.chapters
        .filter((rc) => !isNaN(rc.chapterNumber))
        .map((rc): ChapterStub => ({
          chapterNumber: rc.chapterNumber,
          chapterTitle: rc.chapterTitle,
          chapterUrl: buildChapterUrl(live, reSlug, reHash, rc.chapterNumber),
        }))
        .sort((a, b) => a.chapterNumber - b.chapterNumber);
      this.cachedChapterList.set(seriesUrl, rechapters);

      const emitTarget2 = (ctx as unknown as { eventBus?: { emit: Function } }).eventBus;
      emitTarget2?.emit("adapter.series.resolved", {
        source: SOURCE_ID,
        seriesId: reSlug ? `${SOURCE_ID}:${reSlug}` : SOURCE_ID,
        chapterCount: rechapters.length,
      });

      return {
        seriesTitle: reparsed.title || "Unknown Series",
        coverUrl: reparsed.coverUrl ?? "",
        coverReferer: canonical,
        preEnumeratedChapters: rechapters,
      };
    }

    // Cache for slug-mutation handler.
    this.cachedChapterList.set(seriesUrl, chapters);

    const emitTarget = (ctx as unknown as { eventBus?: { emit: Function } }).eventBus;
    emitTarget?.emit("adapter.series.resolved", {
      source: SOURCE_ID,
      seriesId: slug ? `${SOURCE_ID}:${slug}` : SOURCE_ID,
      chapterCount: chapters.length,
    });

    return {
      seriesTitle: parsed.title || "Unknown Series",
      coverUrl: parsed.coverUrl ?? "",
      coverReferer: canonical,
      preEnumeratedChapters: chapters,
    };
  }

  // -------------------------------------------------------------------------
  // enumerateChapters — chapters are pre-enumerated during resolveSeries;
  // this returns the cached list or re-fetches if needed.
  // -------------------------------------------------------------------------
  async enumerateChapters(
    ctx: AdapterContext,
    series: ResolvedSeries,
  ): Promise<readonly ChapterStub[]> {
    if (
      series.preEnumeratedChapters &&
      series.preEnumeratedChapters.length > 0
    ) {
      return series.preEnumeratedChapters;
    }

    const { preEnumeratedChapters } = await this.resolveSeries(
      ctx,
      series.seriesId,
    );
    return preEnumeratedChapters ?? [];
  }

  // -------------------------------------------------------------------------
  // parseChapterImages — parse images from already-fetched chapter HTML.
  // -------------------------------------------------------------------------
  async parseChapterImages(
    ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]> {
    return this.extractPageStubsFromHtml(ctx, chapter, chapterHtml);
  }

  // -------------------------------------------------------------------------
  // fetchAndParseChapter — the full chapter resolution pipeline:
  //   1. Fetch chapter HTML (with NSFW splash auto-dismiss).
  //   2. 404 → slug-mutation handler.
  //   3. 0 images → Playwright fallback.
  //   4. Still 0 images → try Astro JSON fallback.
  //   5. Emit adapter.chapter.resolved.
  // -------------------------------------------------------------------------
  async fetchAndParseChapter(
    ctx: AdapterContext,
    chapter: ChapterStub,
    originalSeriesUrl: string,
  ): Promise<readonly PageStub[]> {
    const live = await this.resolveLiveDomain(ctx);
    const chapterUrl = this.rewriteHostToLiveDomain(chapter.chapterUrl, live);

    let resp = await ctx.http.get(chapterUrl, {
      referer: undefined,
      signal: ctx.signal,
    });

    // 404 → slug-mutation handler (§10).
    if (resp.statusCode === 404) {
      return this.handleSlugMutation(ctx, chapter, originalSeriesUrl);
    }

    let html = resp.body;

    // Auto-dismiss NSFW splash (§20 Q7 — never block on splash).
    if (isNsfwSplash(html)) {
      await this.dismissNsfwSplash(ctx, chapterUrl);
      resp = await ctx.http.get(chapterUrl, {
        referer: undefined,
        signal: ctx.signal,
      });
      html = resp.body;

      if (isNsfwSplash(html)) {
        html = await ctx.browser.renderPage(chapterUrl, {
          waitForSelector: `img[src*="cdn.asurascans.com"]`,
          state: "attached",
          timeoutMs: 15_000,
        });
      }
    }

    const pages = await this.extractPageStubsFromHtml(ctx, chapter, html);

    const emitTarget = (ctx as unknown as { eventBus?: { emit: Function } }).eventBus;
    emitTarget?.emit("adapter.chapter.resolved", {
      source: SOURCE_ID,
      chapterUrl,
      pageCount: pages.length,
    });

    return pages;
  }

  // -------------------------------------------------------------------------
  // imageRefererFor — returns chapter URL (§15.1: required for CDN 403 prevention).
  // -------------------------------------------------------------------------
  imageRefererFor(chapter: ChapterStub): string {
    return chapter.chapterUrl;
  }

  // -------------------------------------------------------------------------
  // dismissNsfwSplash — set bypass cookies (§20 Q7, idempotent).
  // -------------------------------------------------------------------------
  async dismissNsfwSplash(ctx: AdapterContext, url: string): Promise<void> {
    const host = this.cachedLiveDomain ?? DOMAIN_PROBE_ORDER[0];
    const now = new Date().toISOString();

    for (const { name, value } of NSFW_BYPASS_COOKIES) {
      ctx.cookies.set({
        host,
        domain: host,
        name,
        value,
        path: "/",
        expires: null,
        secure: false,
        httpOnly: false,
        sameSite: null,
        userAgent: "",
        harvestedAt: now,
        lastUsedAt: null,
      });
    }

    ctx.logger.debug({ url, host }, "NSFW bypass cookies set");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private rewriteHostToLiveDomain(url: string, liveDomain: string): string {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (KNOWN_HOSTS.has(host) && host !== liveDomain) {
        parsed.hostname = liveDomain;
        return parsed.toString();
      }
      return url;
    } catch {
      return url;
    }
  }

  private async fetchHtml(ctx: AdapterContext, url: string): Promise<string> {
    const resp = await ctx.http.get(url, { signal: ctx.signal });
    return resp.body;
  }

  private async extractPageStubsFromHtml(
    ctx: AdapterContext,
    chapter: ChapterStub,
    html: string,
  ): Promise<readonly PageStub[]> {
    // Primary: DOM scan via parseChapterPage.
    let { imageUrls } = parseChapterPage(html);

    // Fallback 1: Playwright render if 0 images found.
    if (imageUrls.length === 0) {
      ctx.logger.debug(
        { chapterUrl: chapter.chapterUrl },
        "0 images in initial HTML; falling back to renderPage",
      );
      const hydratedHtml = await ctx.browser.renderPage(chapter.chapterUrl, {
        waitForSelector: `img[src*="cdn.asurascans.com"]`,
        state: "attached",
        timeoutMs: 10_000,
      });
      ({ imageUrls } = parseChapterPage(hydratedHtml));
    }

    // Fallback 2: Astro JSON blob if still 0 images.
    if (imageUrls.length === 0) {
      ctx.logger.debug(
        { chapterUrl: chapter.chapterUrl },
        "0 images after renderPage; trying Astro JSON fallback",
      );
      const fromJson = extractAstroPageJson(html);
      if (fromJson && fromJson.length > 0) {
        imageUrls = fromJson;
      }
    }

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
  // handleSlugMutation — §10 slug-mutation recovery handler.
  //
  // Triggered when a chapter URL returns 404 mid-run.  Re-fetches the series
  // page to find the new hash, rebuilds the chapter URL, retries.
  // -------------------------------------------------------------------------
  private async handleSlugMutation(
    ctx: AdapterContext,
    chapter: ChapterStub,
    originalSeriesUrl: string,
  ): Promise<readonly PageStub[]> {
    let oldSlug = "";
    let oldHash = "";
    try {
      const parsed = parseSlugAndHash(chapter.chapterUrl);
      oldSlug = parsed.slug;
      oldHash = parsed.hash;
    } catch { /* ignore */ }

    const emitTarget = (ctx as unknown as { eventBus?: { emit: Function } }).eventBus;

    emitTarget?.emit("adapter.slug.mutation_detected", {
      source: SOURCE_ID,
      oldSlug,
      oldHash,
      chapterNumber: chapter.chapterNumber,
    });

    ctx.logger.warn(
      { oldSlug, oldHash, chapterNumber: chapter.chapterNumber },
      "Slug mutation detected; re-fetching series to find new hash",
    );

    try {
      const live = await this.resolveLiveDomain(ctx);
      const canonical = this.rewriteHostToLiveDomain(originalSeriesUrl, live);

      const html = await this.fetchHtml(ctx, canonical);
      const reparsed = parseSeriesPage(html, canonical);

      let newSlugInfo: { slug: string; hash: string };
      try {
        newSlugInfo = parseSlugAndHash(canonical);
      } catch {
        newSlugInfo = { slug: reparsed.slug || oldSlug, hash: reparsed.hash || oldHash };
      }

      if (!newSlugInfo.hash || newSlugInfo.hash === oldHash) {
        // Hash unchanged — look for the chapter in the freshly-parsed list.
        const matchingChapter = reparsed.chapters.find(
          (rc) => Math.abs(rc.chapterNumber - chapter.chapterNumber) < 1e-6,
        );
        if (!matchingChapter) {
          throw new Error(
            `Chapter ${chapter.chapterNumber} not found in re-fetched series data`,
          );
        }
        const newUrl = buildChapterUrl(
          live,
          newSlugInfo.slug || oldSlug,
          newSlugInfo.hash || oldHash,
          chapter.chapterNumber,
        );
        return this.retryChapterAfterSlugRepair(ctx, chapter, newUrl, originalSeriesUrl);
      }

      const newUrl = buildChapterUrl(
        live,
        newSlugInfo.slug,
        newSlugInfo.hash,
        chapter.chapterNumber,
      );

      ctx.logger.warn(
        { from: chapter.chapterUrl, to: newUrl },
        "Slug mutation: rebuilt chapter URL",
      );

      return this.retryChapterAfterSlugRepair(ctx, chapter, newUrl, originalSeriesUrl);
    } catch (repairErr) {
      emitTarget?.emit("adapter.slug.mutation_unrecoverable", {
        source: SOURCE_ID,
        oldSlug,
        chapterNumber: chapter.chapterNumber,
        reason: String(repairErr),
      });

      throw new SlugMutationUnrecoverableError(
        chapter.chapterNumber,
        chapter.chapterUrl,
        `Slug mutation unrecoverable for chapter ${chapter.chapterNumber}: ${String(repairErr)}`,
      );
    }
  }

  private async retryChapterAfterSlugRepair(
    ctx: AdapterContext,
    chapter: ChapterStub,
    newUrl: string,
    originalSeriesUrl: string,
  ): Promise<readonly PageStub[]> {
    const resp = await ctx.http.get(newUrl, {
      referer: undefined,
      signal: ctx.signal,
    });

    if (resp.statusCode === 404) {
      const emitTarget = (ctx as unknown as { eventBus?: { emit: Function } }).eventBus;
      let oldSlug = "";
      try {
        oldSlug = parseSlugAndHash(chapter.chapterUrl).slug;
      } catch { /* ignore */ }

      emitTarget?.emit("adapter.slug.mutation_unrecoverable", {
        source: SOURCE_ID,
        oldSlug,
        chapterNumber: chapter.chapterNumber,
        reason: "Second attempt also returned 404",
      });

      throw new SlugMutationUnrecoverableError(
        chapter.chapterNumber,
        chapter.chapterUrl,
        `Chapter ${chapter.chapterNumber} still 404 after slug repair`,
      );
    }

    let html = resp.body;

    if (isNsfwSplash(html)) {
      await this.dismissNsfwSplash(ctx, newUrl);
      const retryResp = await ctx.http.get(newUrl, {
        referer: undefined,
        signal: ctx.signal,
      });
      html = retryResp.body;
    }

    const repairedChapter: ChapterStub = {
      ...chapter,
      chapterUrl: newUrl,
    };

    return this.extractPageStubsFromHtml(ctx, repairedChapter, html);
  }
}
