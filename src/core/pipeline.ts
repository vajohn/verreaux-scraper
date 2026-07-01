import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunConfig, ChapterMeta, SeriesMeta, ChapterStub } from "./types.js";
import { ExitCode } from "./types.js";
import type { EventBus } from "./events.js";
import type { Store } from "../state/store.js";
import type { HttpClient } from "../transport/http.js";
import type { Throttler } from "../transport/throttle.js";
import type { CookieJar } from "../transport/cookies.js";
import type { BrowserPool } from "../transport/browser.js";
import type { CfHandler } from "../transport/cf.js";
import { StagingDir } from "../packaging/staging.js";
import { Packager } from "../packaging/packager.js";
import { buildManifest } from "../pi/manifest.js";
import { adapterRegistry } from "../adapters/index.js";
import type { SourceAdapter, AdapterContext } from "./types.js";
import { selectChapters, EmptyRangeError, NoChaptersInRangeError } from "./selectRange.js";
import { runChapter, type ChapterFailure } from "./chapterRunner.js";
import { RateLimitExhaustedError } from "./imageRunner.js";

export interface PipelineResult {
  runId: string;
  status: "completed" | "partial" | "failed";
  outputPath?: string;
  chaptersAttempted: number;
  chaptersCompleted: number;
  chaptersFailed: ChapterFailure[];
  durationMs: number;
  exitCode: ExitCode;
  /** True when the run stopped early on a source rate limit but still packaged
   *  the chapters downloaded so far. The zip exists and the run is resumable. */
  rateLimited: boolean;
}

export interface PipelineDeps {
  store: Store;
  http: HttpClient;
  throttler: Throttler;
  jar: CookieJar;
  browser: BrowserPool;
  cf: CfHandler;
  eventBus: EventBus;
  ctx: AdapterContext;
}

type PipelineState =
  | "INIT"
  | "RESOLVE_SOURCE"
  | "RESOLVE_SERIES"
  | "ENUMERATE_CHAPTERS"
  | "SELECT_RANGE"
  | "DOWNLOAD_CHAPTERS"
  | "PACKAGE_ZIP"
  | "DONE";

function emitPipelineState(
  eventBus: EventBus,
  state: PipelineState,
): void {
  eventBus.emit("source.probe", { host: state, status: 0, ms: 0 });
}

export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(config: RunConfig, signal: AbortSignal): Promise<PipelineResult> {
    const startTime = Date.now();
    const { store, http, throttler, eventBus, ctx } = this.deps;

    emitPipelineState(eventBus, "INIT");

    // Resume: reuse the most recent non-terminal run for this series URL when
    // --resume is set. The chapters/pages tables are scoped by run_id, so
    // reusing it is what allows the DONE/skip short-circuits in chapterRunner
    // and the SHA-1 dedup in imageRunner to actually find prior work.
    const resumable = config.resume
      ? store.runs.findResumable(config.seriesUrl)
      : undefined;
    const isResume = resumable !== undefined;
    const runId = resumable?.id ?? randomUUID();
    const now = new Date().toISOString();

    if (isResume) {
      store.runs.update(runId, {
        status: "INIT",
      });
      eventBus.emit("run.resumed", {
        priorRunId: runId,
        fromState: resumable.status,
      });
    } else {
      store.runs.create({
        id: runId,
        seriesUrl: config.seriesUrl,
        sourceId: null,
        seriesId: null,
        seriesTitle: null,
        sourceDomain: null,
        seriesPostId: null,
        argsJson: JSON.stringify(config),
        status: "INIT",
        zipPath: null,
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        validated: false,
        rlBudget: 6,
      });
    }

    eventBus.emit("run.init", {
      args: config as unknown as Record<string, unknown>,
      version: "0.1.0",
      nodeVersion: process.version,
      pid: process.pid,
    });

    emitPipelineState(eventBus, "RESOLVE_SOURCE");
    store.runs.update(runId, { status: "RESOLVE_SOURCE" });

    const adapter = adapterRegistry.matchUrl(config.seriesUrl);
    if (!adapter) {
      store.runs.update(runId, {
        status: "FATAL_SOURCE_DEAD",
        exitCode: ExitCode.SOURCE_NOT_FOUND,
        finishedAt: new Date().toISOString(),
      });
      eventBus.emit("run.fatal", {
        code: "ERR_UNKNOWN_SOURCE",
        message: "No adapter found for the given URL",
        state: "RESOLVE_SOURCE",
      });
      return {
        runId,
        status: "failed",
        chaptersAttempted: 0,
        chaptersCompleted: 0,
        chaptersFailed: [],
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.SOURCE_NOT_FOUND,
      };
    }

    store.runs.update(runId, { sourceId: adapter.id });

    emitPipelineState(eventBus, "RESOLVE_SERIES");
    store.runs.update(runId, { status: "RESOLVE_SERIES" });

    let resolvedSeries: {
      seriesTitle: string;
      coverUrl: string;
      coverReferer: string;
      postId?: string;
      preEnumeratedChapters?: readonly ChapterStub[];
    };

    try {
      resolvedSeries = await adapter.resolveSeries(ctx, config.seriesUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.runs.update(runId, {
        status: "FATAL_SERIES_NOT_FOUND",
        exitCode: ExitCode.SOURCE_NOT_FOUND,
        finishedAt: new Date().toISOString(),
      });
      eventBus.emit("run.fatal", {
        code: "ERR_SERIES_NOT_FOUND",
        message: msg,
        state: "RESOLVE_SERIES",
      });
      return {
        runId,
        status: "failed",
        chaptersAttempted: 0,
        chaptersCompleted: 0,
        chaptersFailed: [],
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.SOURCE_NOT_FOUND,
      };
    }

    const seriesId = `${adapter.id}:${config.seriesUrl}`;
    const sourceDomain = new URL(config.seriesUrl).hostname;

    store.runs.update(runId, {
      seriesId,
      seriesTitle: resolvedSeries.seriesTitle,
      sourceDomain,
      seriesPostId: resolvedSeries.postId ?? null,
    });

    eventBus.emit("series.resolved", {
      seriesId,
      seriesTitle: resolvedSeries.seriesTitle,
      coverUrl: resolvedSeries.coverUrl,
      postId: resolvedSeries.postId,
    });

    emitPipelineState(eventBus, "ENUMERATE_CHAPTERS");
    store.runs.update(runId, { status: "ENUMERATE_CHAPTERS" });

    const resolvedSeriesObj = {
      seriesId,
      seriesTitle: resolvedSeries.seriesTitle,
      coverUrl: resolvedSeries.coverUrl,
      coverReferer: resolvedSeries.coverReferer,
      postId: resolvedSeries.postId,
      preEnumeratedChapters: resolvedSeries.preEnumeratedChapters,
    };

    let chapterStubs: readonly ChapterStub[];
    try {
      chapterStubs = await adapter.enumerateChapters(ctx, resolvedSeriesObj);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.runs.update(runId, {
        status: "FATAL_PARSE",
        exitCode: ExitCode.GENERIC,
        finishedAt: new Date().toISOString(),
      });
      eventBus.emit("run.fatal", {
        code: "ERR_ENUMERATE_CHAPTERS",
        message: msg,
        state: "ENUMERATE_CHAPTERS",
      });
      return {
        runId,
        status: "failed",
        chaptersAttempted: 0,
        chaptersCompleted: 0,
        chaptersFailed: [],
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.GENERIC,
      };
    }

    const deduped = deduplicateChapters(chapterStubs);
    deduped.sort((a, b) => a.chapterNumber - b.chapterNumber);

    eventBus.emit("chapters.enumerated", { total: deduped.length });

    for (const stub of deduped) {
      store.chapters.upsert({
        runId,
        chapterNumber: stub.chapterNumber,
        chapterUrl: stub.chapterUrl,
        chapterTitle: stub.chapterTitle,
        selected: false,
        state: "PENDING",
      });
    }

    const chapterMetas: ChapterMeta[] = deduped.map((stub, idx) => ({
      canonicalChapterId: `${seriesId}:ch${stub.chapterNumber}`,
      number: stub.chapterNumber,
      title: stub.chapterTitle,
      urlAtRun: stub.chapterUrl,
      order: idx,
    }));

    emitPipelineState(eventBus, "SELECT_RANGE");
    store.runs.update(runId, { status: "SELECT_RANGE" });

    let selectedChapters: ChapterMeta[];
    try {
      selectedChapters = selectChapters(chapterMetas, config.from, config.to, config.chapters ?? null);
    } catch (err) {
      const code = err instanceof EmptyRangeError || err instanceof NoChaptersInRangeError
        ? "FATAL_EMPTY_RANGE"
        : "FATAL_CONFIG";
      store.runs.update(runId, {
        status: code,
        exitCode: ExitCode.CONFIG_ERROR,
        finishedAt: new Date().toISOString(),
      });
      const msg = err instanceof Error ? err.message : String(err);
      eventBus.emit("run.fatal", {
        code: "ERR_EMPTY_RANGE",
        message: msg,
        state: "SELECT_RANGE",
      });
      return {
        runId,
        status: "failed",
        chaptersAttempted: 0,
        chaptersCompleted: 0,
        chaptersFailed: [],
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.CONFIG_ERROR,
      };
    }

    // When an explicit chapter list is supplied, report its min/max as the
    // effective range so listeners (progress reporter, logs) see a coherent span.
    const hasExplicitList = Array.isArray(config.chapters) && config.chapters.length > 0;
    const eventFrom = hasExplicitList
      ? Math.min(...(config.chapters as readonly number[]))
      : config.from;
    const eventTo: number | "latest" = hasExplicitList
      ? Math.max(...(config.chapters as readonly number[]))
      : config.to;

    eventBus.emit("range.selected", {
      from: eventFrom,
      to: eventTo,
      count: selectedChapters.length,
    });

    for (const ch of selectedChapters) {
      store.chapters.upsert({
        runId,
        chapterNumber: ch.number,
        chapterUrl: ch.urlAtRun,
        chapterTitle: ch.title,
        selected: true,
        state: "PENDING",
      });
    }

    if (config.dryRun) {
      store.runs.update(runId, {
        status: "DONE",
        exitCode: ExitCode.SUCCESS,
        finishedAt: new Date().toISOString(),
      });
      return {
        runId,
        status: "completed",
        chaptersAttempted: 0,
        chaptersCompleted: 0,
        chaptersFailed: [],
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.SUCCESS,
      };
    }

    emitPipelineState(eventBus, "DOWNLOAD_CHAPTERS");
    store.runs.update(runId, { status: "DOWNLOAD_CHAPTERS" });

    const staging = new StagingDir(config.out, runId);
    await staging.init();

    const seriesMeta: SeriesMeta = {
      sourceId: adapter.id,
      canonicalSeriesId: seriesId,
      urlAtRun: config.seriesUrl,
      title: resolvedSeries.seriesTitle,
      coverUrl: resolvedSeries.coverUrl,
      chapters: selectedChapters,
    };

    await fetchCoverIfNeeded(
      resolvedSeries.coverUrl,
      resolvedSeries.coverReferer,
      http,
      staging,
      store,
      config.refreshCover,
      signal,
    );

    eventBus.emit("download.started", {
      count: selectedChapters.length,
      concurrency: config.concurrency,
    });

    const chaptersFailed: ChapterFailure[] = [];
    let chaptersCompleted = 0;
    let chaptersAttempted = 0;
    const concurrency = Math.max(1, Math.min(config.concurrency, 3));

    // Streaming pool: keep up to `concurrency` chapters in flight at all times.
    // When one finishes, immediately launch the next — no head-of-line blocking
    // from a slow chapter holding up siblings that are already done.
    const inflight = new Set<Promise<void>>();
    const unexpectedErrors: unknown[] = [];
    let cursor = 0;

    const launchNext = (): void => {
      if (cursor >= selectedChapters.length) return;
      if (signal.aborted) return;
      const chapter = selectedChapters[cursor++]!;
      chaptersAttempted++;
      const task: Promise<void> = runChapter({
        chapter,
        seriesMeta,
        runId,
        adapter,
        adapterCtx: ctx,
        staging,
        http,
        store,
        eventBus,
        throttler,
        signal,
      })
        .then(
          (result) => {
            if (result.status === "completed") {
              chaptersCompleted++;
            } else if (result.error) {
              chaptersFailed.push(result.error);
            }
          },
          (err: unknown) => {
            // runChapter is expected to capture chapter-level errors and
            // return failed status. An unexpected throw here is a bug —
            // collect it and surface after the pool drains so we don't
            // strand sibling tasks mid-download.
            unexpectedErrors.push(err);
          },
        )
        .finally(() => {
          inflight.delete(task);
        });
      inflight.add(task);
    };

    // Prime the pool
    for (let i = 0; i < concurrency; i++) launchNext();

    // Drain: settle one, top the pool back up, repeat
    while (inflight.size > 0) {
      await Promise.race(inflight);
      if (!signal.aborted && unexpectedErrors.length === 0) {
        while (inflight.size < concurrency && cursor < selectedChapters.length) {
          launchNext();
        }
      }
    }

    // A source rate-limit surfaces here as an unexpected throw. Rather than
    // stranding the work, salvage: if anything has already been staged, fall
    // through to packaging and flag the run partial/resumable. With nothing
    // staged there is nothing to package, so keep the old rethrow behavior.
    let rateLimited = false;
    if (unexpectedErrors.length > 0) {
      const firstErr = unexpectedErrors[0];
      if (firstErr instanceof RateLimitExhaustedError && chaptersCompleted > 0) {
        rateLimited = true;
        store.runs.update(runId, { status: "RATE_LIMITED" });
        eventBus.emit("run.partial_halt", {
          reason: firstErr.message,
          lastChapter: selectedChapters[selectedChapters.length - 1]?.number ?? 0,
        });
      } else {
        throw firstErr;
      }
    }

    if (signal.aborted) {
      store.runs.update(runId, {
        status: "CLEANUP_PARTIAL",
        exitCode: ExitCode.INT_SIGINT,
        finishedAt: new Date().toISOString(),
      });
      eventBus.emit("run.fatal", {
        code: "ERR_ABORTED",
        message: "SIGINT received",
        state: "DOWNLOAD_CHAPTERS",
      });
      return {
        runId,
        status: "partial",
        chaptersAttempted,
        chaptersCompleted,
        chaptersFailed,
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.INT_SIGINT,
      };
    }

    const hasFailures = chaptersFailed.length > 0;

    if (hasFailures && !config.allowPartialZip && !rateLimited) {
      store.runs.update(runId, {
        status: "PARTIAL_HALT",
        exitCode: ExitCode.PARTIAL_RESUME_POSSIBLE,
        finishedAt: new Date().toISOString(),
      });
      eventBus.emit("run.partial_halt", {
        reason: `${chaptersFailed.length} chapter(s) failed`,
        lastChapter: selectedChapters[selectedChapters.length - 1]?.number ?? 0,
      });
      return {
        runId,
        status: "partial",
        chaptersAttempted: selectedChapters.length,
        chaptersCompleted,
        chaptersFailed,
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.PARTIAL_RESUME_POSSIBLE,
      };
    }

    emitPipelineState(eventBus, "PACKAGE_ZIP");
    store.runs.update(runId, { status: "PACKAGE_ZIP" });

    const packager = new Packager(eventBus);
    const outPath = join(config.out, resolvedSeries.seriesTitle.replace(/[\\/:*?"<>|]/g, "_"));

    let zipResult: import("../packaging/packager.js").PackagerBuildResult;
    try {
      zipResult = await packager.build(staging, {
        outPath,
        seriesTitle: resolvedSeries.seriesTitle,
        // On a rate-limit salvage some chapters/pages are necessarily
        // incomplete; force partial packaging so the zip still builds.
        allowPartial: config.allowPartialZip || rateLimited,
        manifest: buildManifest({
          sourceUrl: config.seriesUrl,
          seriesTitle: resolvedSeries.seriesTitle,
          adapter: adapter.id,
          from: config.from,
          to: config.to,
          generatedAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      store.runs.update(runId, {
        status: "PACKAGE_VALIDATION_FAILED",
        exitCode: ExitCode.IO_ERROR,
        finishedAt: new Date().toISOString(),
      });
      return {
        runId,
        status: "failed",
        chaptersAttempted: selectedChapters.length,
        chaptersCompleted,
        chaptersFailed,
        durationMs: Date.now() - startTime,
        rateLimited: false,
        exitCode: ExitCode.IO_ERROR,
      };
    }

    store.runs.update(runId, { zipPath: zipResult.path });

    // A rate-limited salvage is a partial, resumable success: the zip exists
    // but the run stopped short, so it exits 5 like other partial outcomes.
    const isPartial = hasFailures || rateLimited;
    const finalExitCode = isPartial
      ? ExitCode.PARTIAL_RESUME_POSSIBLE
      : ExitCode.SUCCESS;

    emitPipelineState(eventBus, "DONE");
    store.runs.update(runId, {
      status: rateLimited ? "DONE_PARTIAL" : "DONE",
      exitCode: finalExitCode,
      finishedAt: new Date().toISOString(),
      validated: true,
    });

    eventBus.emit("run.done", {
      zipPath: zipResult.path,
      chapterCount: chaptersCompleted,
      bytes: zipResult.byteLength,
      elapsedMs: Date.now() - startTime,
      exitCode: finalExitCode,
    });

    return {
      runId,
      status: isPartial ? "partial" : "completed",
      outputPath: zipResult.path,
      chaptersAttempted: selectedChapters.length,
      chaptersCompleted,
      chaptersFailed,
      durationMs: Date.now() - startTime,
      rateLimited,
      exitCode: finalExitCode,
    };
  }
}

async function fetchCoverIfNeeded(
  coverUrl: string,
  coverReferer: string,
  http: HttpClient,
  staging: StagingDir,
  store: Store,
  refreshCover: boolean,
  signal: AbortSignal,
): Promise<void> {
  try {
    const sha1Key = Buffer.from(coverUrl).toString("base64").slice(0, 40);
    const alreadyHave = !refreshCover && store.hashes.has(sha1Key);
    if (alreadyHave) return;

    const resp = await http.getImage(coverUrl, { referer: coverReferer, signal });
    if (resp.statusCode !== 200) return;

    const buf = resp.body as Buffer;
    const contentType = String(resp.headers["content-type"] ?? "image/jpeg");

    await staging.writeCover(buf, contentType);

    store.hashes.put({
      sha1: sha1Key,
      byteLength: buf.length,
      mime: contentType,
      firstSeenAt: new Date().toISOString(),
    });
  } catch {
  }
}

function deduplicateChapters(stubs: readonly ChapterStub[]): ChapterStub[] {
  const seen = new Map<number, ChapterStub>();
  for (const stub of stubs) {
    if (!seen.has(stub.chapterNumber)) {
      seen.set(stub.chapterNumber, stub);
    }
  }
  return Array.from(seen.values());
}
