import { createHash } from "node:crypto";
import type { PageMeta, ChapterMeta, SourceAdapter, AdapterContext } from "./types.js";
import type { StagingDir } from "../packaging/staging.js";
import { detectImageExt, UnsupportedImageFormatError } from "../packaging/staging.js";
import type { HttpClient } from "../transport/http.js";
import type { Store } from "../state/store.js";
import type { EventBus } from "./events.js";
import type { Throttler } from "../transport/throttle.js";

interface NormalizedImageResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type ImageExt = ".webp" | ".jpg" | ".jpeg" | ".png";

export class InvalidImageFormatError extends Error {
  override readonly name = "InvalidImageFormatError";
  readonly code = "ERR_BAD_MAGIC";
  constructor(message: string) {
    super(message);
  }
}

export class RateLimitExhaustedError extends Error {
  override readonly name = "RateLimitExhaustedError";
  readonly code = "ERR_RATE_LIMIT_EXHAUSTED";
  constructor(host: string) {
    super(`Rate limit exhausted for host: ${host}`);
  }
}

export class ImageUnavailableError extends Error {
  override readonly name = "ImageUnavailableError";
  readonly code = "ERR_IMAGE_UNAVAILABLE";
  constructor(url: string) {
    super(`Image unavailable (403 with correct Referer): ${url}`);
  }
}

export class RefererContractError extends Error {
  override readonly name = "RefererContractError";
  readonly code = "ERR_REFERER_CONTRACT";
  constructor(url: string) {
    super(`Contract bug: 403 with missing/wrong Referer header for ${url}`);
  }
}

export interface ImageRunnerArgs {
  page: PageMeta;
  chapter: ChapterMeta;
  adapter: SourceAdapter;
  adapterCtx: AdapterContext;
  staging: StagingDir;
  http: HttpClient;
  store: Store;
  eventBus: EventBus;
  throttler: Throttler;
  runId: string;
  signal: AbortSignal;
}

export interface ImageRunnerResult {
  sha1: string;
  byteLength: number;
  ext: ImageExt;
}

type ImageState =
  | "REQUEST"
  | "CHECK_HEADERS"
  | "DOWNLOAD"
  | "MAGIC_BYTE_VERIFY"
  | "HASH"
  | "DEDUP_CHECK"
  | "WRITE_STAGING"
  | "DONE";

function emitStateEntered(
  eventBus: EventBus,
  pageNumber: number,
  state: ImageState,
): void {
  eventBus.emit("page.request", {
    chapterNumber: 0,
    pageIndex: pageNumber,
    url: state,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeSha1(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

function detectExt(buf: Buffer): ImageExt {
  try {
    const raw = detectImageExt(buf);
    if (raw === ".jpg") return ".jpg";
    return raw;
  } catch (err) {
    if (err instanceof UnsupportedImageFormatError) {
      throw new InvalidImageFormatError(err.message);
    }
    throw err;
  }
}

export async function runImage(args: ImageRunnerArgs): Promise<ImageRunnerResult> {
  const {
    page,
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
  } = args;

  const emitState = (state: ImageState) => {
    eventBus.emit("page.request", {
      chapterNumber: chapter.number,
      pageIndex: page.pageNumber,
      url: state,
    });
  };

  emitState("REQUEST");

  const existing = store.pages.byChapter(runId, chapter.number).find(
    (p) => p.page_index === page.pageNumber && p.state === "DONE",
  );
  if (existing && existing.sha1 && existing.bytes && existing.ext) {
    emitState("DONE");
    return {
      sha1: existing.sha1,
      byteLength: existing.bytes,
      ext: existing.ext as ImageExt,
    };
  }

  const referer = page.refererOverride ?? chapter.urlAtRun;
  const imageHost = new URL(page.url).hostname;

  const MAX_429_RETRIES = 3;
  const MAX_5XX_RETRIES = 3;
  const BACKOFF_5XX = [2000, 8000, 30000];

  let attempt429 = 0;
  let attempt5xx = 0;

  emitState("CHECK_HEADERS");

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted");
    }

    emitState("DOWNLOAD");

    let response: NormalizedImageResponse;
    let gotResponse: import("got").Response<Buffer> | null = null;
    try {
      if (adapter.fetchImage) {
        response = await adapter.fetchImage({
          ctx: adapterCtx,
          url: page.url,
          referer,
          signal,
        });
      } else {
        gotResponse = await http.getImage(page.url, { referer, signal });
        response = {
          statusCode: gotResponse.statusCode,
          headers: gotResponse.headers,
          body: gotResponse.body as Buffer,
        };
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      eventBus.emit("page.net_err", {
        chapterNumber: chapter.number,
        pageIndex: page.pageNumber,
        errno: String(nodeErr.code ?? "UNKNOWN"),
        syscall: String(nodeErr.syscall ?? ""),
      });
      attempt5xx++;
      if (attempt5xx > MAX_5XX_RETRIES) throw err;
      await sleep(BACKOFF_5XX[attempt5xx - 1] ?? 30000);
      continue;
    }

    const status = response.statusCode;

    if (status === 403) {
      // CF challenge detection only applies to the http path; the browser
      // path is already past CF (it has cf_clearance) and can't surface one
      // here. If a 403 comes back via the browser, it's a genuine
      // authorization failure (referer/cookie), not a CF challenge.
      const isCf = gotResponse ? http.isCloudflareChallenged(gotResponse) : false;
      if (isCf) {
        eventBus.emit("page.cf", {
          chapterNumber: chapter.number,
          pageIndex: page.pageNumber,
          host: imageHost,
        });
        throw new Error("CF challenge surfaced to imageRunner — transport CF chain failed");
      }

      if (!referer) {
        throw new RefererContractError(page.url);
      }

      if (referer === chapter.urlAtRun || referer === page.refererOverride) {
        eventBus.emit("page.403_referer", {
          chapterNumber: chapter.number,
          pageIndex: page.pageNumber,
        });
        throw new ImageUnavailableError(page.url);
      }

      throw new RefererContractError(page.url);
    }

    if (status === 404) {
      eventBus.emit("page.404", {
        chapterNumber: chapter.number,
        pageIndex: page.pageNumber,
        url: page.url,
      });
      throw Object.assign(new Error(`Image 404: ${page.url}`), {
        code: "ERR_IMAGE_404",
        name: "ImageNotFoundError",
      });
    }

    if (status === 429) {
      const retryAfterRaw = response.headers["retry-after"];
      const retryAfter = retryAfterRaw !== undefined
        ? parseInt(String(retryAfterRaw), 10) || null
        : null;

      eventBus.emit("page.429", {
        chapterNumber: chapter.number,
        pageIndex: page.pageNumber,
        retryAfter,
      });

      attempt429++;
      if (attempt429 > MAX_429_RETRIES) {
        eventBus.emit("rate.exhausted", { host: imageHost });
        throw new RateLimitExhaustedError(imageHost);
      }

      const sleepMs = retryAfter != null
        ? retryAfter * 1000 + 250
        : Math.pow(2, attempt429) * 1000;

      throttler.pauseHost(imageHost, sleepMs);
      await sleep(sleepMs);
      continue;
    }

    if (status >= 500) {
      eventBus.emit("page.5xx", {
        chapterNumber: chapter.number,
        pageIndex: page.pageNumber,
        status,
      });
      attempt5xx++;
      if (attempt5xx > MAX_5XX_RETRIES) {
        throw Object.assign(new Error(`HTTP ${status} on ${page.url} after ${attempt5xx} attempts`), {
          code: "ERR_5XX",
        });
      }
      await sleep(BACKOFF_5XX[attempt5xx - 1] ?? 30000);
      continue;
    }

    const buf = response.body as Buffer;
    const contentType = String(response.headers["content-type"] ?? "");

    eventBus.emit("page.bytes", {
      chapterNumber: chapter.number,
      pageIndex: page.pageNumber,
      bytes: buf.length,
      contentType,
    });

    emitState("MAGIC_BYTE_VERIFY");

    let ext: ImageExt;
    try {
      ext = detectExt(buf);
    } catch (err) {
      if (err instanceof InvalidImageFormatError) {
        eventBus.emit("page.hash_fail", {
          chapterNumber: chapter.number,
          pageIndex: page.pageNumber,
          reason: err.message,
        });
        throw err;
      }
      throw err;
    }

    emitState("HASH");
    const sha1 = computeSha1(buf);

    eventBus.emit("page.ok", {
      chapterNumber: chapter.number,
      pageIndex: page.pageNumber,
      sha1,
      ext,
    });

    eventBus.emit("page.hashed", {
      chapterNumber: chapter.number,
      pageIndex: page.pageNumber,
      sha1,
    });

    emitState("DEDUP_CHECK");

    const chapterPages = store.pages.byChapter(runId, chapter.number);
    const dedupHit = chapterPages.find(
      (p) => p.sha1 === sha1 && p.page_index !== page.pageNumber && p.state === "DONE",
    );

    if (dedupHit) {
      eventBus.emit("page.sha1_drift", {
        chapterNumber: chapter.number,
        pageIndex: page.pageNumber,
        oldSha1: sha1,
        newSha1: sha1,
      });
    }

    emitState("WRITE_STAGING");

    await staging.writePage(chapter.number, page.pageNumber, buf, contentType);

    store.pages.markStatus(runId, chapter.number, page.pageNumber, "DONE", {
      sha1,
      bytes: buf.length,
      ext,
    });

    eventBus.emit("page.done", {
      chapterNumber: chapter.number,
      pageIndex: page.pageNumber,
    });

    emitState("DONE");

    return { sha1, byteLength: buf.length, ext };
  }
}
