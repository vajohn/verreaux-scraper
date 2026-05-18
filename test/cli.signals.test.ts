/**
 * cli.signals.test.ts — SIGINT / SIGTERM graceful shutdown handler.
 *
 * We mock process.exit and trigger signal handlers by calling process.emit
 * after cleanly removing pre-existing handlers. Each test is isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installSignalHandlers } from "../src/cli/signals.js";
import { EventBus } from "../src/core/events.js";

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
// Per-test isolation: snapshot all listeners, strip everything, restore after.
// ---------------------------------------------------------------------------

type SignalName = "SIGINT" | "SIGTERM";
let savedListeners: Record<SignalName, NodeJS.SignalListener[]>;
let exitMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedListeners = {
    SIGINT: (process.rawListeners("SIGINT") as NodeJS.SignalListener[]).slice(),
    SIGTERM: (process.rawListeners("SIGTERM") as NodeJS.SignalListener[]).slice(),
  };
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");

  exitMock = vi.spyOn(process, "exit").mockImplementation((_code?: unknown) => {
    throw new Error(`process.exit(${_code}) called`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const h of savedListeners.SIGINT) process.on("SIGINT", h);
  for (const h of savedListeners.SIGTERM) process.on("SIGTERM", h);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("installSignalHandlers", () => {
  it("first SIGINT calls controller.abort()", () => {
    const controller = new AbortController();
    const logger = makeFakeLogger();
    const bus = new EventBus();

    installSignalHandlers(controller, logger, bus);

    // Emit the first SIGINT.
    process.emit("SIGINT");

    expect(controller.signal.aborted).toBe(true);
    // Remove the second-signal handler registered by requestAbort so it
    // doesn't interfere with afterEach.
    process.removeAllListeners("SIGINT");
  });

  it("first SIGINT emits run.fatal event on the event bus", () => {
    const controller = new AbortController();
    const logger = makeFakeLogger();
    const bus = new EventBus();

    const events: string[] = [];
    bus.on((e) => events.push(e.type));

    installSignalHandlers(controller, logger, bus);

    process.emit("SIGINT");

    expect(events).toContain("run.fatal");
    process.removeAllListeners("SIGINT");
  });

  it("SIGTERM behaves the same as first SIGINT (calls abort)", () => {
    const controller = new AbortController();
    const logger = makeFakeLogger();

    installSignalHandlers(controller, logger);

    process.emit("SIGTERM");

    expect(controller.signal.aborted).toBe(true);
    process.removeAllListeners("SIGINT");
  });

  it("second SIGINT within the window exits with code 130", () => {
    const controller = new AbortController();
    const logger = makeFakeLogger();

    installSignalHandlers(controller, logger);

    // First signal — arms the second handler and calls abort.
    process.emit("SIGINT");

    // Second signal — should call process.exit(130).
    expect(() => {
      process.emit("SIGINT");
    }).toThrow("process.exit(130) called");

    expect(exitMock).toHaveBeenCalledWith(130);
    process.removeAllListeners("SIGINT");
  });
});
