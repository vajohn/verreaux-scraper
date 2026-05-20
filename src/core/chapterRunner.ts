import type {
  ChapterMeta,
  SeriesMeta,
  SourceAdapter,
  AdapterContext,
  ChapterStub,
  PageStub,
} from "./types.js";
import type { StagingDir } from "../packaging/staging.js";
import type { HttpClient } from "../transport/http.js";
import type { Store } from "../state/store.js";
import type { EventBus } from "./events.js";
import type { Throttler } from "../transport/throttle.js";
import {
  runImage,
  RateLimitExhaustedError,
  InvalidImageFormatError,
  type ImageRunnerResult,
} from "./imageRunner.js";

export interface ChapterFailure {
  chapterNumber: number;
  code: string;
  reason: string;
}

export interface ChapterRunnerResult {
  status: "completed" | "failed";
  pageCount: number;
  error?: ChapterFailure;
}

export interface ChapterRunnerArgs {
  chapter: ChapterMeta;
  seriesMeta: SeriesMeta;
  runId: string;
  adapter: SourceAdapter;
  adapterCtx: AdapterContext;
  staging: StagingDir;
  http: HttpClient;
  store: Store;
  eventBus: EventBus;
  throttler: Throttler;
  signal: AbortSignal;
}

type ChapterState =
  | "RESOLVE"
  | "FETCH_IMAGE_URLS"
  | "DOWNLOAD_PAGES"
  | "VERIFY_CHAPTER"
  | "COMMIT"
  | "DONE";

function emitChapterState(
  eventBus: EventBus,
  chapterNumber: number,
  state: ChapterState,
): void {
  eventBus.emit("chapter.resolve", { chapterNumber, url: state });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_MISSING_PAGES = 2;

export async function runChapter(args: ChapterRunnerArgs): Promise<ChapterRunnerResult> {
  const {
    chapter,
    seriesMeta,
    runId,
    adapter,
    adapterCtx,
    staging,
    http,
    store,
    eventBus,
    throttler,
    signal,
  } = args;

  emitChapterState(eventBus, chapter.number, "RESOLVE");

  const existingChapter = store.chapters
    .byRun(runId)
    .find((c) => c.chapter_number === chapter.number);

  if (existingChapter?.state === "DONE") {
    return { status: "completed", pageCount: existingChapter.expected_page_count ?? 0 };
  }

  store.chapters.markStatus(runId, chapter.number, "RESOLVING");

  eventBus.emit("chapter.queued", { chapterNumber: chapter.number });
  eventBus.emit("chapter.resolve", { chapterNumber: chapter.number, url: chapter.urlAtRun });

  const chapterStub: ChapterStub = {
    chapterNumber: chapter.number,
    chapterTitle: chapter.title,
    chapterUrl: chapter.urlAtRun,
  };

  let chapterHtml: string;
  try {
    if (adapter.fetchChapter) {
      const resp = await adapter.fetchChapter({
        ctx: adapterCtx,
        chapter: chapterStub,
        seriesUrl: seriesMeta.urlAtRun,
        signal,
      });
      if (resp.statusCode === 404) {
        return failChapter(store, eventBus, runId, chapter.number, "ERR_CHAPTER_404", `Chapter ${chapter.number} returned 404`);
      }
      if (resp.statusCode >= 500) {
        return failChapter(store, eventBus, runId, chapter.number, "ERR_CHAPTER_5XX", `Chapter ${chapter.number} returned ${resp.statusCode}`);
      }
      chapterHtml = resp.body;
    } else {
      const resp = await http.get(chapter.urlAtRun, {
        referer: seriesMeta.urlAtRun,
        signal,
      });

      if (resp.statusCode === 404) {
        return failChapter(store, eventBus, runId, chapter.number, "ERR_CHAPTER_404", `Chapter ${chapter.number} returned 404`);
      }

      if (resp.statusCode >= 500) {
        return failChapter(store, eventBus, runId, chapter.number, "ERR_CHAPTER_5XX", `Chapter ${chapter.number} returned ${resp.statusCode}`);
      }

      if (resp.statusCode === 403 || resp.statusCode === 503) {
        const isCf = http.isCloudflareChallenged(resp);
        if (isCf) {
          eventBus.emit("chapter.cf_challenge", { chapterNumber: chapter.number });
          return failChapter(store, eventBus, runId, chapter.number, "ERR_CF_CHALLENGE", "CF challenge on chapter page");
        }
      }

      chapterHtml = resp.body;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failChapter(store, eventBus, runId, chapter.number, "ERR_CHAPTER_FETCH", msg);
  }

  emitChapterState(eventBus, chapter.number, "FETCH_IMAGE_URLS");
  store.chapters.markStatus(runId, chapter.number, "FETCHING_IMAGES");

  let pageStubs: readonly PageStub[];
  try {
    pageStubs = await adapter.parseChapterImages(adapterCtx, chapterStub, chapterHtml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failChapter(store, eventBus, runId, chapter.number, "ERR_PARSE", msg);
  }

  if (pageStubs.length === 0) {
    eventBus.emit("chapter.failed", {
      chapterNumber: chapter.number,
      code: "ERR_CHAPTER_EMPTY",
      reason: "Zero images parsed",
    });
    store.chapters.markStatus(runId, chapter.number, "FAILED", {
      errorCode: "ERR_CHAPTER_EMPTY",
      errorReason: "Zero images parsed",
    });
    return { status: "failed", pageCount: 0, error: { chapterNumber: chapter.number, code: "ERR_CHAPTER_EMPTY", reason: "Zero images parsed" } };
  }

  eventBus.emit("chapter.images_parsed", {
    chapterNumber: chapter.number,
    pageCount: pageStubs.length,
  });

  store.chapters.markStatus(runId, chapter.number, "DOWNLOADING", {
    expectedPageCount: pageStubs.length,
  });

  for (const stub of pageStubs) {
    store.pages.upsert({
      runId,
      chapterNumber: chapter.number,
      pageIndex: stub.pageIndex,
      imageUrl: stub.imageUrl,
      referer: stub.referer,
      state: "PENDING",
    });
  }

  const existingPages = store.pages.byChapter(runId, chapter.number);
  const completedPageNums = new Set(
    existingPages.filter((p) => p.state === "DONE").map((p) => p.page_index),
  );

  emitChapterState(eventBus, chapter.number, "DOWNLOAD_PAGES");

  const results: Array<{ pageNumber: number; result: ImageRunnerResult | null; error?: Error }> = [];
  let totalBytes = 0;
  let missingCount = 0;

  for (const stub of pageStubs) {
    if (signal.aborted) {
      return failChapter(store, eventBus, runId, chapter.number, "ERR_ABORTED", "Aborted");
    }

    if (completedPageNums.has(stub.pageIndex)) {
      const existing = existingPages.find((p) => p.page_index === stub.pageIndex);
      if (existing && existing.sha1 && existing.bytes) {
        results.push({ pageNumber: stub.pageIndex, result: { sha1: existing.sha1, byteLength: existing.bytes, ext: (existing.ext ?? ".jpg") as ".webp" | ".jpg" | ".jpeg" | ".png" | ".svg" } });
        totalBytes += existing.bytes;
        continue;
      }
    }

    const pageMeta = {
      pageNumber: stub.pageIndex,
      url: stub.imageUrl,
      refererOverride: stub.referer,
    };

    try {
      const result = await runImage({
        page: pageMeta,
        chapter,
        adapter,
        adapterCtx,
        staging,
        http,
        store,
        eventBus,
        throttler,
        runId,
        signal,
      });
      results.push({ pageNumber: stub.pageIndex, result });
      totalBytes += result.byteLength;

      eventBus.emit("chapter.download.progress", {
        chapterNumber: chapter.number,
        done: results.length,
        total: pageStubs.length,
        bytes: totalBytes,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      if (err instanceof RateLimitExhaustedError || err instanceof InvalidImageFormatError) {
        store.pages.markStatus(runId, chapter.number, stub.pageIndex, "FAILED", {
          errorCode: (err as { code?: string }).code ?? "ERR_IMAGE",
          errorReason: error.message,
        });
        return failChapter(
          store,
          eventBus,
          runId,
          chapter.number,
          (err as { code?: string }).code ?? "ERR_IMAGE",
          error.message,
        );
      }

      const errCode = (error as { code?: string }).code;
      if (errCode === "ERR_IMAGE_404") {
        missingCount++;
        results.push({ pageNumber: stub.pageIndex, result: null, error });
        store.pages.markStatus(runId, chapter.number, stub.pageIndex, "FAILED", {
          errorCode: "ERR_IMAGE_404",
          errorReason: `Image 404 for page ${stub.pageIndex}`,
        });

        if (missingCount > MAX_MISSING_PAGES) {
          return failChapter(
            store,
            eventBus,
            runId,
            chapter.number,
            "ERR_TOO_MANY_MISSING",
            `Too many missing pages (${missingCount})`,
          );
        }
        continue;
      }

      missingCount++;
      results.push({ pageNumber: stub.pageIndex, result: null, error });
      store.pages.markStatus(runId, chapter.number, stub.pageIndex, "FAILED", {
        errorCode: errCode ?? "ERR_IMAGE",
        errorReason: error.message,
      });

      if (missingCount > MAX_MISSING_PAGES) {
        return failChapter(
          store,
          eventBus,
          runId,
          chapter.number,
          "ERR_TOO_MANY_MISSING",
          `Too many missing pages (${missingCount})`,
        );
      }
    }
  }

  emitChapterState(eventBus, chapter.number, "VERIFY_CHAPTER");
  store.chapters.markStatus(runId, chapter.number, "VERIFYING");

  const successfulResults = results.filter((r) => r.result !== null);
  const hashes = successfulResults.map((r) => r.result!.sha1);

  // Single-page chapters trivially have one unique hash — skip the check.
  // A real placeholder pattern requires ≥2 identical pages to be suspicious.
  if (hashes.length >= 2) {
    const uniqueHashes = new Set(hashes);
    if (uniqueHashes.size === 1) {
      eventBus.emit("chapter.failed", {
        chapterNumber: chapter.number,
        code: "ERR_PLACEHOLDER_DETECTED",
        reason: "All pages have identical SHA-1 hash — likely placeholder/CAPTCHA image",
      });
      store.chapters.markStatus(runId, chapter.number, "FAILED", {
        errorCode: "ERR_PLACEHOLDER_DETECTED",
        errorReason: "All pages identical hash",
      });
      return {
        status: "failed",
        pageCount: 0,
        error: {
          chapterNumber: chapter.number,
          code: "ERR_PLACEHOLDER_DETECTED",
          reason: "All pages have identical SHA-1 hash — likely placeholder/CAPTCHA image",
        },
      };
    }
  }

  eventBus.emit("chapter.verified", { chapterNumber: chapter.number });

  emitChapterState(eventBus, chapter.number, "COMMIT");

  store.chapters.markStatus(runId, chapter.number, "DONE", {
    verified: true,
    expectedPageCount: pageStubs.length,
  });

  eventBus.emit("chapter.staged", {
    chapterNumber: chapter.number,
    folder: `Chapter ${String(chapter.number).padStart(3, "0")}`,
  });

  emitChapterState(eventBus, chapter.number, "DONE");

  eventBus.emit("chapter.done", {
    chapterNumber: chapter.number,
    pageCount: successfulResults.length,
    bytes: totalBytes,
    elapsedMs: 0,
  });

  return { status: "completed", pageCount: successfulResults.length };
}

function failChapter(
  store: Store,
  eventBus: EventBus,
  runId: string,
  chapterNumber: number,
  code: string,
  reason: string,
): ChapterRunnerResult {
  store.chapters.markStatus(runId, chapterNumber, "FAILED", {
    errorCode: code,
    errorReason: reason,
  });
  eventBus.emit("chapter.failed", { chapterNumber, code, reason });
  return { status: "failed", pageCount: 0, error: { chapterNumber, code, reason } };
}
