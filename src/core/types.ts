import type { z } from "zod";
import type { runConfigSchema } from "./runConfigSchema.js";
import type { HttpClient } from "../transport/http.js";
import type { BrowserPool } from "../transport/browser.js";
import type { CookieJar } from "../transport/cookies.js";
import type { Throttler } from "../transport/throttle.js";
import type pino from "pino";

// ---------------------------------------------------------------------------
// Exit codes (§12)
// ---------------------------------------------------------------------------

export const enum ExitCode {
  SUCCESS = 0,
  GENERIC = 1,
  CONFIG_ERROR = 2,
  CF_UNSOLVABLE = 3,
  SOURCE_NOT_FOUND = 4,
  PARTIAL_RESUME_POSSIBLE = 5,
  IO_ERROR = 6,
  USER_ABORT = 7,
  INT_SIGINT = 130,
}

// ---------------------------------------------------------------------------
// Image / media
// ---------------------------------------------------------------------------

export type ImgExt = ".webp" | ".jpg" | ".jpeg" | ".png";

export interface ImageHash {
  readonly sha1: string;
  readonly byteLength: number;
  readonly mime: string;
  readonly firstSeenAt: string;
}

// ---------------------------------------------------------------------------
// Cookie store
// ---------------------------------------------------------------------------

export interface CookieRecord {
  readonly domain: string;
  readonly name: string;
  readonly value: string;
  readonly path: string;
  readonly expires: number | null;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "Strict" | "Lax" | "None" | null;
  readonly userAgent: string;
  readonly harvestedAt: string;
  readonly lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// Run state (§8 — mirrors `runs` table columns)
// ---------------------------------------------------------------------------

export type RunStatus =
  | "INIT"
  | "RESOLVE_SOURCE"
  | "DOMAIN_ROTATION"
  | "RESOLVE_SERIES"
  | "SLUG_REPAIR"
  | "ENUMERATE_CHAPTERS"
  | "SELECT_RANGE"
  | "DOWNLOAD_CHAPTERS"
  | "RATE_LIMITED"
  | "CF_CHALLENGE"
  | "PACKAGE_ZIP"
  | "VALIDATE_PACKAGE"
  | "CLEANUP"
  | "PARTIAL_HALT"
  | "CLEANUP_PARTIAL"
  | "DONE"
  | "DONE_PARTIAL"
  | "FATAL_CONFIG"
  | "FATAL_SOURCE_DEAD"
  | "FATAL_SERIES_NOT_FOUND"
  | "FATAL_CF_UNSOLVABLE"
  | "FATAL_PARSE"
  | "FATAL_EMPTY_RANGE"
  | "PACKAGE_VALIDATION_FAILED";

export interface RunState {
  readonly id: string;
  readonly seriesUrl: string;
  readonly sourceId: string | null;
  readonly seriesId: string | null;
  readonly seriesTitle: string | null;
  readonly sourceDomain: string | null;
  readonly seriesPostId: string | null;
  readonly argsJson: string;
  readonly status: RunStatus;
  readonly zipPath: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly validated: boolean;
  readonly rlBudget: number;
}

// ---------------------------------------------------------------------------
// Chapter / page state (§8)
// ---------------------------------------------------------------------------

export type ChapterStatus =
  | "PENDING"
  | "RESOLVING"
  | "FETCHING_IMAGES"
  | "DOWNLOADING"
  | "VERIFYING"
  | "STAGED"
  | "DONE"
  | "FAILED";

export type PageStatus = "PENDING" | "IN_FLIGHT" | "DONE" | "FAILED";

// ---------------------------------------------------------------------------
// Series / chapter / page descriptors (domain model)
// ---------------------------------------------------------------------------

export interface ChapterMeta {
  readonly canonicalChapterId: string;
  readonly number: number;
  readonly title: string | null;
  readonly urlAtRun: string;
  readonly order: number;
}

export interface PageMeta {
  readonly pageNumber: number;
  readonly url: string;
  readonly refererOverride?: string;
}

export interface SeriesMeta {
  readonly sourceId: string;
  readonly canonicalSeriesId: string;
  readonly urlAtRun: string;
  readonly title: string;
  readonly coverUrl: string;
  readonly chapters: readonly ChapterMeta[];
}

// Lightweight stub used during enumeration before full ChapterMeta is available
export interface ChapterStub {
  readonly chapterNumber: number;
  readonly chapterTitle: string | null;
  readonly chapterUrl: string;
}

export interface PageStub {
  readonly pageIndex: number;
  readonly imageUrl: string;
  readonly referer: string;
}

export interface ResolvedSeries {
  readonly seriesId: string;
  readonly seriesTitle: string;
  readonly coverUrl: string;
  readonly coverReferer: string;
  readonly postId?: string;
  readonly preEnumeratedChapters?: readonly ChapterStub[];
}

// ---------------------------------------------------------------------------
// Adapter context (§15.3)
// ---------------------------------------------------------------------------

export interface AdapterContext {
  readonly http: HttpClient;
  readonly browser: BrowserPool;
  readonly cookies: CookieJar;
  readonly logger: pino.Logger;
  readonly throttle: Throttler;
  readonly signal: AbortSignal;
  /** Run-level settings the adapter may consult (group selection, etc.).
   *  Optional so existing adapters that don't need config keep working. */
  readonly config?: RunConfig;
}

// ---------------------------------------------------------------------------
// Scanlation group descriptor — adapters that expose group selection use this
// to communicate the available groups for a series.
// ---------------------------------------------------------------------------

export interface GroupInfo {
  /** Stable adapter-internal identifier (e.g. numeric API id as string). */
  readonly id: string;
  /** Human-readable group name shown in prompts and logs. */
  readonly name: string;
  /** Optional URL slug if the source exposes one. */
  readonly slug?: string;
  /** Optional chapter count attributed to this group. */
  readonly chapterCount?: number;
}

// ---------------------------------------------------------------------------
// Source adapter interface (§15.3)
// ---------------------------------------------------------------------------

export interface SourceAdapter {
  readonly id: "asurascans" | "manhuaplus" | "arenascan" | "drake";

  matchHost(host: string): boolean;

  domainAliases(): readonly string[];

  resolveSeries(
    ctx: AdapterContext,
    seriesUrl: string,
  ): Promise<{
    seriesTitle: string;
    coverUrl: string;
    coverReferer: string;
    postId?: string;
    preEnumeratedChapters?: readonly ChapterStub[];
  }>;

  enumerateChapters(ctx: AdapterContext, series: ResolvedSeries): Promise<readonly ChapterStub[]>;

  parseChapterImages(
    ctx: AdapterContext,
    chapter: ChapterStub,
    chapterHtml: string,
  ): Promise<readonly PageStub[]>;

  /** Optional: fetch the chapter HTML through an adapter-controlled transport.
   *  Used when the default http.get path is blocked by Cloudflare and the
   *  adapter has a per-host BrowserContext that can clear it (cf_clearance is
   *  UA-bound to the harvesting browser, so reusing the cleared context is the
   *  only reliable bypass). When absent, chapterRunner uses HttpClient.get. */
  fetchChapter?(args: {
    ctx: AdapterContext;
    chapter: ChapterStub;
    seriesUrl: string;
    signal: AbortSignal;
  }): Promise<{ statusCode: number; body: string }>;

  imageRefererFor(chapter: ChapterStub): string;

  /** Optional: download an image through an adapter-controlled transport
   *  (e.g. through the per-host BrowserContext so cf_clearance / session
   *  cookies are honored).  When absent, imageRunner falls back to the
   *  shared HttpClient.  Returns a normalized response with the raw bytes. */
  fetchImage?(args: {
    ctx: AdapterContext;
    url: string;
    referer: string;
    signal: AbortSignal;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>;

  // Auto-dismisses NSFW splash screens per §20 Q7 override.
  // Sets bypass cookies (safe_browse=0, wpmanga-adult-confirmed=1, etc.) without prompting.
  dismissNsfwSplash(ctx: AdapterContext, url: string): Promise<void>;

  liveDomain(): string;

  /** Optional: list scanlation groups for a series.
   *  Adapters that don't have group selection (e.g. arenascan, asurascans)
   *  should leave this undefined. The CLI uses this to validate --group,
   *  print --list-groups output, and prompt the user when needed. */
  listGroups?(ctx: AdapterContext, seriesUrl: string): Promise<readonly GroupInfo[]>;
}

// ---------------------------------------------------------------------------
// Run configuration (§3 CLI flags)
// ---------------------------------------------------------------------------

export interface RunConfig {
  readonly seriesUrl: string;
  readonly from: number;
  readonly to: number | "latest";
  /** Explicit chapter list. If non-null, overrides from/to. */
  readonly chapters: readonly number[] | null;
  readonly out: string;
  readonly format: "webp" | "original";
  readonly concurrency: number;
  readonly resume: boolean;
  readonly refreshCover: boolean;
  readonly allowPartialZip: boolean;
  readonly flaresolverrUrl: string | null;
  readonly headful: boolean;
  readonly cookiesFrom: string | null;
  readonly log: "json" | "pretty";
  readonly dryRun: boolean;
  /** If true, launch Playwright in headed mode for Turnstile human-intervention.
   *  Maps to the --headful CLI flag (§7 CF_HUMAN_PROMPT). */
  readonly allowHeadedCloudflare?: boolean;
  /** Scanlation-group selection. Adapter-specific identifier or name.
   *  Null means the adapter should prompt (TTY) or auto-select if unambiguous. */
  readonly group: string | null;
}

// Re-export the zod schema type once it exists — stub here for the barrel
export type RunConfigInput = z.input<typeof runConfigSchema>;
export type RunConfigParsed = z.output<typeof runConfigSchema>;
