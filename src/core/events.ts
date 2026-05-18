// pino uses `export =` (CJS-compat), so the default import is the function itself.
import pino from "pino";

// ---------------------------------------------------------------------------
// Envelope wrapper (§13)
// ---------------------------------------------------------------------------

export interface Envelope<T = unknown> {
  readonly ts: string;
  readonly runId: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly state: string;
  readonly event: string;
  readonly payload: T;
}

// ---------------------------------------------------------------------------
// Per-event payload shapes (§13.1 – §13.5)
// ---------------------------------------------------------------------------

// §13.1 Lifecycle
interface RunInitPayload {
  args: Record<string, unknown>;
  version: string;
  nodeVersion: string;
  pid: number;
}

interface RunResumedPayload {
  priorRunId: string;
  fromState: string;
}

interface RunPartialHaltPayload {
  reason: string;
  lastChapter: number;
}

interface RunFatalPayload {
  code: string;
  message: string;
  state: string;
}

interface RunDonePayload {
  zipPath: string;
  chapterCount: number;
  bytes: number;
  elapsedMs: number;
  exitCode: number;
}

// §13.2 Source / domain
interface SourceResolvedPayload {
  source: string;
  sourceDomain: string;
}

interface SourceProbePayload {
  host: string;
  status: number;
  ms: number;
}

interface SourceAltProbePayload {
  tried: string;
  result: "live" | "dead";
}

interface SourceDomainRotatedPayload {
  from: string;
  to: string;
}

interface SourceDeadPayload {
  host: string;
}

// §13.3 Series / slug
interface SeriesResolvedPayload {
  seriesId: string;
  seriesTitle: string;
  coverUrl: string;
  postId?: string;
}

interface SlugDetectPayload {
  deadUrl: string;
}

interface SlugSearchPayload {
  query: string;
  candidates: number;
}

interface SlugRepairedPayload {
  from: string;
  to: string;
  similarity: number;
}

interface SlugFailPayload {
  deadUrl: string;
  reason: string;
}

// §13.4 Chapter / pages
interface ChaptersEnumeratedPayload {
  total: number;
}

interface RangeSelectedPayload {
  from: number;
  to: number | "latest";
  count: number;
}

interface DownloadStartedPayload {
  count: number;
  concurrency: number;
}

interface ChapterQueuedPayload {
  chapterNumber: number;
}

interface ChapterResolvePayload {
  chapterNumber: number;
  url: string;
}

interface ChapterSlugRepairedPayload {
  chapterNumber: number;
  from: string;
  to: string;
}

interface ChapterImagesParsedPayload {
  chapterNumber: number;
  pageCount: number;
}

interface ChapterDownloadProgressPayload {
  chapterNumber: number;
  done: number;
  total: number;
  bytes: number;
}

interface ChapterVerifiedPayload {
  chapterNumber: number;
}

interface ChapterStagedPayload {
  chapterNumber: number;
  folder: string;
}

interface ChapterDonePayload {
  chapterNumber: number;
  pageCount: number;
  bytes: number;
  elapsedMs: number;
}

interface ChapterTransientFailPayload {
  chapterNumber: number;
  attempts: number;
  reason: string;
}

interface ChapterCfChallengePayload {
  chapterNumber: number;
}

interface ChapterFailedPayload {
  chapterNumber: number;
  code: string;
  reason: string;
}

interface PageQueuedPayload {
  chapterNumber: number;
  pageIndex: number;
}

interface PageRequestPayload {
  chapterNumber: number;
  pageIndex: number;
  url: string;
}

interface PageBytesPayload {
  chapterNumber: number;
  pageIndex: number;
  bytes: number;
  contentType: string;
}

interface PageOkPayload {
  chapterNumber: number;
  pageIndex: number;
  sha1: string;
  ext: string;
}

interface PageHashedPayload {
  chapterNumber: number;
  pageIndex: number;
  sha1: string;
}

interface Page403RefererPayload {
  chapterNumber: number;
  pageIndex: number;
}

interface Page404Payload {
  chapterNumber: number;
  pageIndex: number;
  url: string;
}

interface PageListRefetchedPayload {
  chapterNumber: number;
  pageIndex: number;
  oldUrl: string;
  newUrl: string;
}

interface PageCfPayload {
  chapterNumber: number;
  pageIndex: number;
  host: string;
}

interface Page429Payload {
  chapterNumber: number;
  pageIndex: number;
  retryAfter: number | null;
}

interface Page5xxPayload {
  chapterNumber: number;
  pageIndex: number;
  status: number;
}

interface PageNetErrPayload {
  chapterNumber: number;
  pageIndex: number;
  errno: string;
  syscall: string;
}

interface PageHashFailPayload {
  chapterNumber: number;
  pageIndex: number;
  reason: string;
}

interface PageSha1DriftPayload {
  chapterNumber: number;
  pageIndex: number;
  oldSha1: string;
  newSha1: string;
}

interface PageFailedPayload {
  chapterNumber: number;
  pageIndex: number;
  code: string;
  reason: string;
}

interface PageDonePayload {
  chapterNumber: number;
  pageIndex: number;
}

// §13.5 CF / rate / package
interface CfDetectedPayload {
  host: string;
  reason: string;
  status: number;
}

interface CfJarCheckedPayload {
  host: string;
  hit: boolean;
}

interface CfReusePayload {
  host: string;
  ageMs: number;
}

interface CfRetryPayload {
  url: string;
  status: number;
}

interface CfBrowserLaunchPayload {
  host: string;
  headful: boolean;
}

interface CfTurnstilePayload {
  host: string;
}

interface CfHumanPromptPayload {
  host: string;
  timeoutSec: number;
}

interface CfHarvestedPayload {
  host: string;
  cookieNames: readonly string[];
}

interface CfFsCallPayload {
  url: string;
}

interface CfFsOkPayload {
  url: string;
}

interface CfFsFailPayload {
  url: string;
  reason: string;
}

interface CfClearedPayload {
  host: string;
}

interface CfFailPayload {
  host: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Adapter-specific events (§13 — adapter.* namespace)
// ---------------------------------------------------------------------------

interface AdapterLiveDomainResolvedPayload {
  source: string;
  domain: string;
  probeOrderMs: number;
}

interface AdapterSeriesResolvedPayload {
  source: string;
  seriesId: string;
  chapterCount: number;
}

interface AdapterChapterResolvedPayload {
  source: string;
  chapterUrl: string;
  pageCount: number;
}

interface AdapterSlugMutationDetectedPayload {
  source: string;
  oldSlug: string;
  oldHash: string;
  chapterNumber: number;
}

interface AdapterSlugMutationUnrecoverablePayload {
  source: string;
  oldSlug: string;
  chapterNumber: number;
  reason: string;
}

// Additional CF events used by transport layer
interface CfStateEnteredPayload {
  /** The §7 state identifier, e.g. "CF_DETECT", "CF_CHECK_JAR", … */
  state: string;
}

interface CfAbortedPayload {
  host: string;
}

interface CfFlareSolverrUnavailablePayload {
  endpoint: string;
}

interface RateDetectPayload {
  host: string;
  retryAfter: number | null;
}

interface RateBackoffPayload {
  host: string;
  sleepMs: number;
}

interface RateThrottleAdjustedPayload {
  newConcurrency: number;
  newRatePerSec: number;
}

interface RateExhaustedPayload {
  host: string;
}

interface PackageStartedPayload {
  chapterCount: number;
}

interface PackageWrittenPayload {
  zipPath: string;
  bytes: number;
}

interface ValidateOkPayload {
  zipPath: string;
  chapterCount: number;
  pageCount: number;
}

interface ValidateFailedPayload {
  zipPath: string;
  violations: readonly string[];
}

interface CleanupOkPayload {
  stagingDir: string;
}

interface CleanupPartialPayload {
  stagingDir: string;
}

// ---------------------------------------------------------------------------
// Discriminated union of all scraper events (§13)
// ---------------------------------------------------------------------------

export type ScraperEvent =
  // §13.1 Lifecycle
  | { type: "run.init"; payload: RunInitPayload }
  | { type: "run.resumed"; payload: RunResumedPayload }
  | { type: "run.partial_halt"; payload: RunPartialHaltPayload }
  | { type: "run.fatal"; payload: RunFatalPayload }
  | { type: "run.done"; payload: RunDonePayload }
  // §13.2 Source / domain
  | { type: "source.resolved"; payload: SourceResolvedPayload }
  | { type: "source.probe"; payload: SourceProbePayload }
  | { type: "source.alt_probe"; payload: SourceAltProbePayload }
  | { type: "source.domain_rotated"; payload: SourceDomainRotatedPayload }
  | { type: "source.dead"; payload: SourceDeadPayload }
  // §13.3 Series / slug
  | { type: "series.resolved"; payload: SeriesResolvedPayload }
  | { type: "slug.detect"; payload: SlugDetectPayload }
  | { type: "slug.search"; payload: SlugSearchPayload }
  | { type: "slug.repaired"; payload: SlugRepairedPayload }
  | { type: "slug.fail"; payload: SlugFailPayload }
  // §13.4 Chapters / pages
  | { type: "chapters.enumerated"; payload: ChaptersEnumeratedPayload }
  | { type: "range.selected"; payload: RangeSelectedPayload }
  | { type: "download.started"; payload: DownloadStartedPayload }
  | { type: "chapter.queued"; payload: ChapterQueuedPayload }
  | { type: "chapter.resolve"; payload: ChapterResolvePayload }
  | { type: "chapter.slug_repaired"; payload: ChapterSlugRepairedPayload }
  | { type: "chapter.images_parsed"; payload: ChapterImagesParsedPayload }
  | { type: "chapter.download.progress"; payload: ChapterDownloadProgressPayload }
  | { type: "chapter.verified"; payload: ChapterVerifiedPayload }
  | { type: "chapter.staged"; payload: ChapterStagedPayload }
  | { type: "chapter.done"; payload: ChapterDonePayload }
  | { type: "chapter.transient_fail"; payload: ChapterTransientFailPayload }
  | { type: "chapter.cf_challenge"; payload: ChapterCfChallengePayload }
  | { type: "chapter.failed"; payload: ChapterFailedPayload }
  | { type: "page.queued"; payload: PageQueuedPayload }
  | { type: "page.request"; payload: PageRequestPayload }
  | { type: "page.bytes"; payload: PageBytesPayload }
  | { type: "page.ok"; payload: PageOkPayload }
  | { type: "page.hashed"; payload: PageHashedPayload }
  | { type: "page.403_referer"; payload: Page403RefererPayload }
  | { type: "page.404"; payload: Page404Payload }
  | { type: "page.list_refetched"; payload: PageListRefetchedPayload }
  | { type: "page.cf"; payload: PageCfPayload }
  | { type: "page.429"; payload: Page429Payload }
  | { type: "page.5xx"; payload: Page5xxPayload }
  | { type: "page.net_err"; payload: PageNetErrPayload }
  | { type: "page.hash_fail"; payload: PageHashFailPayload }
  | { type: "page.sha1_drift"; payload: PageSha1DriftPayload }
  | { type: "page.failed"; payload: PageFailedPayload }
  | { type: "page.done"; payload: PageDonePayload }
  // §13.5 CF / rate / package
  | { type: "cf.detected"; payload: CfDetectedPayload }
  | { type: "cf.jar_checked"; payload: CfJarCheckedPayload }
  | { type: "cf.reuse"; payload: CfReusePayload }
  | { type: "cf.retry"; payload: CfRetryPayload }
  | { type: "cf.browser_launch"; payload: CfBrowserLaunchPayload }
  | { type: "cf.turnstile"; payload: CfTurnstilePayload }
  | { type: "cf.human_prompt"; payload: CfHumanPromptPayload }
  | { type: "cf.harvested"; payload: CfHarvestedPayload }
  | { type: "cf.fs_call"; payload: CfFsCallPayload }
  | { type: "cf.fs_ok"; payload: CfFsOkPayload }
  | { type: "cf.fs_fail"; payload: CfFsFailPayload }
  | { type: "cf.cleared"; payload: CfClearedPayload }
  | { type: "cf.fail"; payload: CfFailPayload }
  | { type: "cf.state.entered"; payload: CfStateEnteredPayload }
  | { type: "cf.aborted"; payload: CfAbortedPayload }
  | { type: "cf.flaresolverr.unavailable"; payload: CfFlareSolverrUnavailablePayload }
  | { type: "rate.detect"; payload: RateDetectPayload }
  | { type: "rate.backoff"; payload: RateBackoffPayload }
  | { type: "rate.throttle_adjusted"; payload: RateThrottleAdjustedPayload }
  | { type: "rate.exhausted"; payload: RateExhaustedPayload }
  | { type: "package.started"; payload: PackageStartedPayload }
  | { type: "package.written"; payload: PackageWrittenPayload }
  | { type: "validate.ok"; payload: ValidateOkPayload }
  | { type: "validate.failed"; payload: ValidateFailedPayload }
  | { type: "cleanup.ok"; payload: CleanupOkPayload }
  | { type: "cleanup.partial"; payload: CleanupPartialPayload }
  // Adapter events
  | { type: "adapter.live_domain.resolved"; payload: AdapterLiveDomainResolvedPayload }
  | { type: "adapter.series.resolved"; payload: AdapterSeriesResolvedPayload }
  | { type: "adapter.chapter.resolved"; payload: AdapterChapterResolvedPayload }
  | { type: "adapter.slug.mutation_detected"; payload: AdapterSlugMutationDetectedPayload }
  | { type: "adapter.slug.mutation_unrecoverable"; payload: AdapterSlugMutationUnrecoverablePayload };

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private readonly handlers: Array<(event: ScraperEvent) => void> = [];

  emit<T extends ScraperEvent["type"]>(
    type: T,
    payload: Extract<ScraperEvent, { type: T }>["payload"],
  ): void {
    const event = { type, payload } as ScraperEvent;
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  on(handler: (event: ScraperEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }
}

// ---------------------------------------------------------------------------
// Pino logger sink
// ---------------------------------------------------------------------------

// Fields whose values must be redacted before logging (§security).
// Pino's redact uses dot-notation paths within the logged object.
const REDACT_PATHS = [
  "payload.cookie",
  "payload.cookies",
  "payload.set-cookie",
  "payload.headers.cookie",
  "payload.headers['set-cookie']",
  "payload.headers['cookie']",
  "payload.responseHeaders.cookie",
  "payload.responseHeaders['set-cookie']",
];

export function createPinoSink(options: {
  level?: "debug" | "info" | "warn" | "error";
  transport?: pino.TransportSingleOptions;
}): pino.Logger {
  return pino({
    level: options.level ?? "info",
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    ...(options.transport ? { transport: options.transport } : {}),
  });
}

// Convenience: attach a pino sink to an EventBus. Returns the unsubscribe fn.
export function attachPinoSink(
  bus: EventBus,
  runId: string,
  state: () => string,
  logger: pino.Logger,
): () => void {
  return bus.on((event) => {
    const envelope: Envelope = {
      ts: new Date().toISOString(),
      runId,
      level: levelForEvent(event),
      state: state(),
      event: event.type,
      payload: event.payload,
    };
    logger[envelope.level](envelope, event.type);
  });
}

// Map event type to the spec-mandated log level (§13 tables).
function levelForEvent(event: ScraperEvent): "debug" | "info" | "warn" | "error" {
  switch (event.type) {
    case "run.fatal":
    case "source.dead":
    case "slug.fail":
    case "chapter.failed":
    case "page.hash_fail":
    case "page.failed":
    case "cf.fs_fail":
    case "cf.fail":
    case "rate.exhausted":
    case "validate.failed":
    case "cf.flaresolverr.unavailable":
      return "error";

    case "run.partial_halt":
    case "source.domain_rotated":
    case "slug.repaired":
    case "chapter.transient_fail":
    case "chapter.slug_repaired":
    case "page.404":
    case "page.list_refetched":
    case "page.429":
    case "page.5xx":
    case "page.net_err":
    case "page.sha1_drift":
    case "cf.detected":
    case "cf.turnstile":
    case "cf.aborted":
    case "rate.detect":
    case "rate.backoff":
    case "rate.throttle_adjusted":
    case "cleanup.partial":
      return "warn";

    case "run.init":
    case "run.resumed":
    case "run.done":
    case "source.resolved":
    case "series.resolved":
    case "chapters.enumerated":
    case "range.selected":
    case "download.started":
    case "chapter.done":
    case "cf.browser_launch":
    case "cf.human_prompt":
    case "cf.harvested":
    case "cf.fs_ok":
    case "cf.cleared":
    case "package.started":
    case "package.written":
    case "validate.ok":
    case "cleanup.ok":
      return "info";

    default:
      return "debug";
  }
}
