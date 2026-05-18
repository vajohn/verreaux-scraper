/**
 * signals.ts — SIGINT / SIGTERM graceful-shutdown wiring.
 *
 * First SIGINT (or any SIGTERM):
 *   - emits run.fatal via the event bus
 *   - calls controller.abort()
 *   - arms a 10-second force-exit timer
 *
 * Second SIGINT within the 10-second window → hard exit(130) immediately.
 *
 * Implementation note: we use two `process.once` calls in sequence. The
 * first-SIGINT handler re-arms a second `process.once("SIGINT")` for the
 * hard exit. This avoids the problem of a permanent `process.on("SIGINT")`
 * handler that fires alongside the `process.once`.
 */

import type pino from "pino";
import type { EventBus } from "../core/events.js";

export function installSignalHandlers(
  controller: AbortController,
  logger: pino.Logger,
  eventBus?: EventBus,
): void {
  let hardExitTimer: ReturnType<typeof setTimeout> | null = null;

  function forceExit(): void {
    logger.warn("second interrupt received — forcing exit 130");
    if (hardExitTimer) clearTimeout(hardExitTimer);
    process.exit(130);
  }

  function requestAbort(signal: NodeJS.Signals): void {
    logger.warn({ signal }, "interrupt received — requesting graceful shutdown (10s)");

    // Notify the pipeline via the event bus.
    try {
      eventBus?.emit("run.fatal", {
        code: "ERR_ABORTED",
        message: "run.aborted.requested",
        state: "DOWNLOAD_CHAPTERS",
      });
    } catch {
      // Event bus may already be torn down; ignore.
    }

    controller.abort();

    // Arm the second-signal hard-exit handler.
    process.once("SIGINT", forceExit);

    // Safety net: force-exit if pipeline does not finish in 10 seconds.
    hardExitTimer = setTimeout(() => {
      logger.error("graceful shutdown timed out after 10s — forcing exit 130");
      process.exit(130);
    }, 10_000);

    // Allow Node to exit naturally if everything finishes before the timer.
    if (hardExitTimer.unref) hardExitTimer.unref();
  }

  process.once("SIGINT", () => requestAbort("SIGINT"));
  process.once("SIGTERM", () => requestAbort("SIGTERM"));
}
