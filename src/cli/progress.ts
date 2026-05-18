/**
 * progress.ts — human-friendly console reporter.
 *
 * Subscribes to the EventBus and renders either:
 *   - pretty TTY: a multi-line dashboard with one live progress line per
 *     in-flight chapter, plus an aggregate summary. Re-drawn in place on
 *     every event. Completion / error / info lines are pushed *above* the
 *     live block so the dashboard always stays anchored at the bottom.
 *   - plain non-TTY: line-by-line output (one line per chapter progress
 *     tick, sampled every 10 pages).
 *   - NDJSON (--log-format json or CI env).
 *
 * No external deps beyond pino (already present). No cli-progress / ora.
 */

import type { EventBus, ScraperEvent } from "../core/events.js";
import type pino from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressReporterOptions {
  logFormat: "json" | "pretty";
  noColor: boolean;
  /** Writable stream, defaults to process.stdout */
  stream?: NodeJS.WriteStream & { fd?: number };
}

interface ChapterProgress {
  chapterNumber: number;
  done: number;
  total: number;
  bytes: number;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

function c(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtEta(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "--:--";
  const totalSec = Math.round(ms / 1000);
  const mm = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtRate(bytesPerSec: number): string {
  if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return "    --";
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(bytesPerSec / 1024).toFixed(0)} kB/s`;
}

function zeroPad(n: number, w = 3): string {
  return n.toString().padStart(w, "0");
}

function bar(done: number, total: number, width = 10): string {
  if (total <= 0) return "░".repeat(width);
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// ProgressReporter
// ---------------------------------------------------------------------------

export class ProgressReporter {
  private readonly out: NodeJS.WriteStream & { fd?: number };
  private readonly isTty: boolean;
  private readonly colorEnabled: boolean;
  private readonly jsonMode: boolean;
  private readonly logger: pino.Logger;

  // Live dashboard state
  private readonly active = new Map<number, ChapterProgress>();
  private chapterTotal = 0;
  private completedCount = 0;
  private failedCount = 0;
  private completedBytes = 0;
  private downloadStartMs = Date.now();
  private lastBlockHeight = 0;

  constructor(
    private readonly eventBus: EventBus,
    logger: pino.Logger,
    opts: ProgressReporterOptions,
  ) {
    this.out = opts.stream ?? process.stdout;
    this.isTty = (this.out as NodeJS.WriteStream).isTTY === true;
    this.colorEnabled = this.isTty && !opts.noColor && opts.logFormat !== "json";
    this.jsonMode = opts.logFormat === "json" || (!this.isTty && opts.logFormat !== "pretty");
    this.logger = logger;
  }

  attach(): () => void {
    return this.eventBus.on((event) => this.handleEvent(event));
  }

  private handleEvent(event: ScraperEvent): void {
    if (this.jsonMode) {
      this.emitJson(event);
      return;
    }

    switch (event.type) {
      case "run.init": {
        this.downloadStartMs = Date.now();
        this.println(
          c(this.colorEnabled, BOLD + CYAN, "Verreaux Scraper") +
          `  v${event.payload.version}  pid=${event.payload.pid}`,
        );
        break;
      }

      case "run.resumed": {
        this.println(
          c(this.colorEnabled, BOLD + CYAN, "Resuming prior run  ") +
          `id=${event.payload.priorRunId.slice(0, 8)}  fromState=${event.payload.fromState}`,
        );
        break;
      }

      case "series.resolved": {
        this.println(
          c(this.colorEnabled, GREEN + BOLD, "Series resolved: ") +
          c(this.colorEnabled, BOLD, event.payload.seriesTitle),
        );
        break;
      }

      case "chapters.enumerated": {
        this.chapterTotal = event.payload.total;
        this.println(
          `Found ${c(this.colorEnabled, BOLD, String(event.payload.total))} chapters`,
        );
        break;
      }

      case "range.selected": {
        const toStr = event.payload.to === "latest" ? "latest" : String(event.payload.to);
        this.println(
          `Range selected: chapters ${event.payload.from}–${toStr}  ` +
          `(${event.payload.count} chapters)`,
        );
        break;
      }

      case "download.started": {
        this.downloadStartMs = Date.now();
        this.completedCount = 0;
        this.failedCount = 0;
        this.completedBytes = 0;
        this.active.clear();
        this.chapterTotal = event.payload.count;
        this.println(`Downloading ${event.payload.count} chapters  concurrency=${event.payload.concurrency}`);
        break;
      }

      case "chapter.images_parsed": {
        this.active.set(event.payload.chapterNumber, {
          chapterNumber: event.payload.chapterNumber,
          done: 0,
          total: event.payload.pageCount,
          bytes: 0,
          startedAt: Date.now(),
        });
        this.flushBlock();
        break;
      }

      case "chapter.download.progress": {
        const entry = this.active.get(event.payload.chapterNumber);
        if (entry) {
          entry.done = event.payload.done;
          entry.total = event.payload.total;
          entry.bytes = event.payload.bytes;
        } else {
          // Late progress event (or images_parsed never fired) — synthesise.
          this.active.set(event.payload.chapterNumber, {
            chapterNumber: event.payload.chapterNumber,
            done: event.payload.done,
            total: event.payload.total,
            bytes: event.payload.bytes,
            startedAt: Date.now(),
          });
        }
        this.flushBlock();
        break;
      }

      case "chapter.done": {
        const entry = this.active.get(event.payload.chapterNumber);
        if (entry) {
          this.completedBytes += entry.bytes;
          this.active.delete(event.payload.chapterNumber);
        } else {
          this.completedBytes += event.payload.bytes;
        }
        this.completedCount++;
        this.printAboveBlock(
          c(this.colorEnabled, GREEN, "✓ Chapter ") +
          c(this.colorEnabled, BOLD, zeroPad(event.payload.chapterNumber)) +
          c(this.colorEnabled, DIM, ` — ${event.payload.pageCount} pages, `) +
          c(this.colorEnabled, DIM, `${(event.payload.bytes / 1024).toFixed(0)} kB, `) +
          c(this.colorEnabled, DIM, `${(event.payload.elapsedMs / 1000).toFixed(1)}s`),
        );
        break;
      }

      case "chapter.failed": {
        this.active.delete(event.payload.chapterNumber);
        this.failedCount++;
        this.printAboveBlock(
          c(this.colorEnabled, RED + BOLD, "✗ Chapter ") +
          c(this.colorEnabled, BOLD, zeroPad(event.payload.chapterNumber)) +
          c(this.colorEnabled, RED, ` FAILED [${event.payload.code}]: ${event.payload.reason}`),
        );
        break;
      }

      case "package.started": {
        this.clearBlock();
        this.println(`Packaging ${event.payload.chapterCount} chapters into ZIP...`);
        break;
      }

      case "package.written": {
        this.println(
          c(this.colorEnabled, GREEN + BOLD, "ZIP written: ") +
          event.payload.zipPath +
          c(this.colorEnabled, DIM, `  (${(event.payload.bytes / 1024 / 1024).toFixed(2)} MB)`),
        );
        break;
      }

      case "run.done": {
        const elapsed = (event.payload.elapsedMs / 1000).toFixed(1);
        this.println(
          c(this.colorEnabled, GREEN + BOLD, "Done. ") +
          `${event.payload.chapterCount} chapters, ` +
          `${(event.payload.bytes / 1024 / 1024).toFixed(2)} MB, ` +
          `${elapsed}s`,
        );
        break;
      }

      case "run.partial_halt": {
        this.clearBlock();
        this.println(
          c(this.colorEnabled, YELLOW + BOLD, "Partial halt: ") +
          event.payload.reason +
          "  (re-run with --resume to continue)",
        );
        break;
      }

      case "run.fatal": {
        this.clearBlock();
        this.println(
          c(this.colorEnabled, RED + BOLD, `Fatal [${event.payload.code}]: `) +
          event.payload.message,
        );
        break;
      }

      case "cf.detected": {
        this.printAboveBlock(
          c(this.colorEnabled, YELLOW, "Cloudflare challenge detected on ") +
          event.payload.host +
          " — resolving...",
        );
        break;
      }

      case "cf.cleared": {
        this.printAboveBlock(c(this.colorEnabled, GREEN, `Cloudflare cleared for ${event.payload.host}`));
        break;
      }

      case "cf.human_prompt": {
        this.printAboveBlock(
          c(this.colorEnabled, YELLOW + BOLD,
            "Cloudflare Turnstile detected. Solve the puzzle in the visible browser window. " +
            `Press ENTER when done (${event.payload.timeoutSec}s timeout).`,
          ),
        );
        break;
      }

      case "source.domain_rotated": {
        this.printAboveBlock(
          c(this.colorEnabled, YELLOW, `Domain rotated: ${event.payload.from} → ${event.payload.to}`),
        );
        break;
      }

      case "rate.detect": {
        const after = event.payload.retryAfter != null
          ? ` (retry-after: ${event.payload.retryAfter}s)`
          : "";
        this.printAboveBlock(c(this.colorEnabled, YELLOW, `Rate limited on ${event.payload.host}${after} — backing off`));
        break;
      }

      case "validate.ok": {
        this.println(c(this.colorEnabled, GREEN, `ZIP validated — ${event.payload.chapterCount} chapters, ${event.payload.pageCount} pages`));
        break;
      }

      case "validate.failed": {
        this.println(
          c(this.colorEnabled, RED + BOLD, "ZIP validation FAILED: ") +
          event.payload.violations.join("; "),
        );
        break;
      }

      default:
        // Debug / trace events — silently ignored in pretty mode.
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Multi-line block rendering
  // ---------------------------------------------------------------------------

  /**
   * Render the live block: one line per active chapter + an aggregate summary.
   * Clears the previous block first by moving cursor up and erasing to end of
   * screen, so the block stays anchored at the bottom of the terminal.
   */
  private flushBlock(): void {
    if (!this.isTty) {
      // Non-TTY fallback: emit a sampled line per chapter progress tick.
      for (const entry of this.active.values()) {
        if (entry.done > 0 && (entry.done % 10 === 0 || entry.done === entry.total)) {
          this.out.write(
            `Chapter ${zeroPad(entry.chapterNumber)} | Page ${zeroPad(entry.done)}/${zeroPad(entry.total)}\n`,
          );
        }
      }
      return;
    }

    this.clearBlock();

    const lines = this.buildBlockLines();
    for (const line of lines) {
      this.out.write(`${line}\n`);
    }
    this.lastBlockHeight = lines.length;
  }

  /** Erase the previous live block from screen and reset its height counter. */
  private clearBlock(): void {
    if (!this.isTty) return;
    if (this.lastBlockHeight > 0) {
      // Move cursor up N lines to column 1, then clear from cursor to end of screen.
      this.out.write(`\x1b[${this.lastBlockHeight}A\x1b[J`);
      this.lastBlockHeight = 0;
    }
  }

  /**
   * Print a permanent line above the live block, then re-render the block
   * underneath. Used for chapter completion lines, CF alerts, and any other
   * one-shot event that should scroll naturally above the dashboard.
   */
  private printAboveBlock(text: string): void {
    if (this.isTty) {
      this.clearBlock();
      this.out.write(`${text}\n`);
      this.flushBlock();
    } else {
      this.out.write(`${text}\n`);
    }
  }

  private buildBlockLines(): string[] {
    const lines: string[] = [];
    const sortedActive = Array.from(this.active.values()).sort(
      (a, b) => a.chapterNumber - b.chapterNumber,
    );

    for (const entry of sortedActive) {
      const elapsedMs = Math.max(1, Date.now() - entry.startedAt);
      const rate = (entry.bytes * 1000) / elapsedMs;
      const pagesRemaining = Math.max(0, entry.total - entry.done);
      const etaMs = entry.done > 0
        ? (pagesRemaining / entry.done) * elapsedMs
        : Infinity;

      const line =
        `  ${c(this.colorEnabled, BOLD, "Chapter " + zeroPad(entry.chapterNumber))}` +
        `  [${c(this.colorEnabled, CYAN, bar(entry.done, entry.total))}]` +
        `  ${zeroPad(entry.done)}/${zeroPad(entry.total)}` +
        `  ${c(this.colorEnabled, DIM, fmtRate(rate).padStart(9))}` +
        `  ${c(this.colorEnabled, DIM, "ETA " + fmtEta(etaMs))}`;
      lines.push(line);
    }

    // Aggregate summary line
    const totalElapsedMs = Math.max(1, Date.now() - this.downloadStartMs);
    let aggregateBytes = this.completedBytes;
    for (const entry of this.active.values()) aggregateBytes += entry.bytes;
    const aggregateRate = (aggregateBytes * 1000) / totalElapsedMs;

    const summary =
      c(this.colorEnabled, DIM, "  [") +
      `${this.completedCount}/${this.chapterTotal} done` +
      ` · ${this.failedCount} failed` +
      ` · ${this.active.size} active` +
      ` · ${fmtRate(aggregateRate)}` +
      ` · elapsed ${fmtEta(totalElapsedMs)}` +
      c(this.colorEnabled, DIM, "]");
    lines.push(summary);

    return lines;
  }

  private println(text: string): void {
    if (this.isTty && this.lastBlockHeight > 0) {
      this.clearBlock();
      this.out.write(`${text}\n`);
      this.flushBlock();
    } else {
      this.out.write(`${text}\n`);
    }
  }

  private emitJson(event: ScraperEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event: event.type, payload: event.payload });
    this.out.write(`${line}\n`);
  }
}
