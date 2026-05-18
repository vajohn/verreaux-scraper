/**
 * errorMap.ts — maps typed error instances to exit codes per §12.
 *
 * Pure function; no side-effects. All error classes are imported at the top so
 * the compiler enforces they exist and types remain accurate across refactors.
 */

import { ExitCode } from "../core/types.js";
import { EmptyRangeError, NoChaptersInRangeError } from "../core/selectRange.js";
import { CfUnsolvableError } from "../transport/cf.js";
import { InvalidImageFormatError, RateLimitExhaustedError } from "../core/imageRunner.js";
import { NextDataNotFoundError } from "../adapters/asurascans.helpers.js";
import { LilianaParseError } from "../adapters/manhuaplus.helpers.js";
import { SlugMutationUnrecoverableError } from "../adapters/asurascans.js";
import { AbortError } from "../transport/browser.js";

/** Sentinel attached by signal handler when the process was force-killed. */
export const FORCED_ABORT_SYMBOL = Symbol("forced_abort");

/**
 * Map any thrown value to the correct process exit code.
 *
 * The `forced` flag distinguishes a user-requested graceful abort (exit 7)
 * from the second-SIGINT hard exit (exit 130).
 */
export function mapErrorToExitCode(err: unknown, forced = false): number {
  // AbortError — graceful vs. forced
  if (err instanceof AbortError) {
    return forced ? ExitCode.INT_SIGINT : ExitCode.USER_ABORT;
  }

  // Native DOMException with name "AbortError" (e.g. from AbortSignal)
  if (
    err instanceof Error &&
    err.name === "AbortError"
  ) {
    return forced ? ExitCode.INT_SIGINT : ExitCode.USER_ABORT;
  }

  // Config / range errors → 2
  if (err instanceof EmptyRangeError || err instanceof NoChaptersInRangeError) {
    return ExitCode.CONFIG_ERROR;
  }

  // CF unsolvable → 3
  if (err instanceof CfUnsolvableError) {
    return ExitCode.CF_UNSOLVABLE;
  }

  // Source / adapter contract violations → 4
  if (
    err instanceof NextDataNotFoundError ||
    err instanceof LilianaParseError ||
    err instanceof SlugMutationUnrecoverableError
  ) {
    return ExitCode.SOURCE_NOT_FOUND;
  }

  // Rate limit exhausted → 5 (user can resume)
  if (err instanceof RateLimitExhaustedError) {
    return ExitCode.PARTIAL_RESUME_POSSIBLE;
  }

  // Invalid image format → 6 (IO / parser error)
  if (err instanceof InvalidImageFormatError) {
    return ExitCode.IO_ERROR;
  }

  // Generic Error → 1
  if (err instanceof Error) {
    return ExitCode.GENERIC;
  }

  // Unknown throw value → 1
  return ExitCode.GENERIC;
}
