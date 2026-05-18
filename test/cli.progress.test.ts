/**
 * cli.progress.test.ts — ProgressReporter subscribes to event bus and renders
 * correct output for a sample event sequence.
 */

import { describe, it, expect, vi } from "vitest";
import { ProgressReporter } from "../src/cli/progress.js";
import { EventBus } from "../src/core/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream() {
  const lines: string[] = [];
  const stream = {
    isTTY: false,
    write: vi.fn((chunk: string) => {
      lines.push(chunk);
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, lines };
}

function makeFakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import("pino").Logger;
}

// ---------------------------------------------------------------------------
// Tests: pretty mode (non-TTY → line-by-line, no ANSI rewrites)
// ---------------------------------------------------------------------------

describe("ProgressReporter — pretty mode (non-TTY)", () => {
  it("prints series resolved and chapter done lines", () => {
    const bus = new EventBus();
    const { stream, lines } = makeMockStream();
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "pretty",
      noColor: true,
      stream,
    });
    const detach = reporter.attach();

    bus.emit("series.resolved", {
      seriesId: "test:test",
      seriesTitle: "My Series",
      coverUrl: "https://example.com/cover.webp",
    });

    bus.emit("chapters.enumerated", { total: 5 });

    bus.emit("chapter.done", {
      chapterNumber: 1,
      pageCount: 20,
      bytes: 512000,
      elapsedMs: 3000,
    });

    detach();

    const combined = lines.join("");
    expect(combined).toContain("My Series");
    expect(combined).toContain("5"); // chapter count
    expect(combined).toContain("001"); // chapter 1 zero-padded
  });

  it("prints fatal event with code and message", () => {
    const bus = new EventBus();
    const { stream, lines } = makeMockStream();
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "pretty",
      noColor: true,
      stream,
    });
    const detach = reporter.attach();

    bus.emit("run.fatal", {
      code: "ERR_UNKNOWN_SOURCE",
      message: "No adapter found",
      state: "RESOLVE_SOURCE",
    });

    detach();

    const combined = lines.join("");
    expect(combined).toContain("ERR_UNKNOWN_SOURCE");
    expect(combined).toContain("No adapter found");
  });

  it("detach() stops receiving events", () => {
    const bus = new EventBus();
    const { stream, lines } = makeMockStream();
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "pretty",
      noColor: true,
      stream,
    });
    const detach = reporter.attach();
    detach();

    bus.emit("series.resolved", {
      seriesId: "x:x",
      seriesTitle: "After Detach",
      coverUrl: "https://example.com/c.webp",
    });

    const combined = lines.join("");
    expect(combined).not.toContain("After Detach");
  });
});

// ---------------------------------------------------------------------------
// Tests: JSON mode
// ---------------------------------------------------------------------------

describe("ProgressReporter — JSON mode", () => {
  it("emits valid JSON lines for all events", () => {
    const bus = new EventBus();
    const { stream, lines } = makeMockStream();
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "json",
      noColor: false,
      stream,
    });
    const detach = reporter.attach();

    bus.emit("run.init", {
      args: {},
      version: "0.1.0",
      nodeVersion: "v20.0.0",
      pid: 1234,
    });

    bus.emit("series.resolved", {
      seriesId: "asurascans:test",
      seriesTitle: "Test Series",
      coverUrl: "https://example.com/cover.webp",
    });

    bus.emit("chapter.done", {
      chapterNumber: 3,
      pageCount: 15,
      bytes: 200000,
      elapsedMs: 2000,
    });

    detach();

    // All written chunks should be JSON lines
    const jsonLines = lines
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(jsonLines.length).toBeGreaterThanOrEqual(3);

    for (const line of jsonLines) {
      let parsed: unknown;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect(parsed).toHaveProperty("event");
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("payload");
    }
  });

  it("JSON lines contain the correct event type", () => {
    const bus = new EventBus();
    const { stream, lines } = makeMockStream();
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "json",
      noColor: false,
      stream,
    });
    const detach = reporter.attach();

    bus.emit("run.done", {
      zipPath: "/tmp/out.zip",
      chapterCount: 10,
      bytes: 1024000,
      elapsedMs: 60000,
      exitCode: 0,
    });

    detach();

    const jsonLines = lines.join("").split("\n").filter((l) => l.trim());
    expect(jsonLines).toHaveLength(1);

    const parsed = JSON.parse(jsonLines[0]!) as Record<string, unknown>;
    expect(parsed["event"]).toBe("run.done");
    const payload = parsed["payload"] as Record<string, unknown>;
    expect(payload["chapterCount"]).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: progress line rendering (TTY mode)
// ---------------------------------------------------------------------------

describe("ProgressReporter — TTY progress rendering", () => {
  it("emits a progress line with chapter/page numbers on download.progress", () => {
    const bus = new EventBus();
    const writes: string[] = [];
    const stream = {
      isTTY: true,
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
    } as unknown as NodeJS.WriteStream;
    const logger = makeFakeLogger();

    const reporter = new ProgressReporter(bus, logger, {
      logFormat: "pretty",
      noColor: true,
      stream,
    });
    const detach = reporter.attach();

    // Prime the chapter total
    bus.emit("download.started", { count: 5, concurrency: 1 });
    bus.emit("chapter.images_parsed", { chapterNumber: 2, pageCount: 20 });

    bus.emit("chapter.download.progress", {
      chapterNumber: 2,
      done: 10,
      total: 20,
      bytes: 50000,
    });

    detach();

    const combined = writes.join("");
    // Should contain chapter and page numbers
    expect(combined).toContain("002");
    expect(combined).toContain("010");
    expect(combined).toContain("020");
  });
});
