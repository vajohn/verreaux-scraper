/**
 * cli.errorMap.test.ts — Each typed error class maps to the expected exit code.
 */

import { describe, it, expect } from "vitest";
import { mapErrorToExitCode } from "../src/cli/errorMap.js";
import { ExitCode } from "../src/core/types.js";
import { EmptyRangeError, NoChaptersInRangeError } from "../src/core/selectRange.js";
import { CfUnsolvableError } from "../src/transport/cf.js";
import { InvalidImageFormatError, RateLimitExhaustedError } from "../src/core/imageRunner.js";
import { NextDataNotFoundError } from "../src/adapters/asurascans.helpers.js";
import { LilianaParseError } from "../src/adapters/manhuaplus.helpers.js";
import { SlugMutationUnrecoverableError } from "../src/adapters/asurascans.js";
import { AbortError } from "../src/transport/browser.js";

describe("mapErrorToExitCode", () => {
  describe("config / range errors → 2", () => {
    it("maps EmptyRangeError → CONFIG_ERROR (2)", () => {
      expect(mapErrorToExitCode(new EmptyRangeError(5, 3))).toBe(ExitCode.CONFIG_ERROR);
    });

    it("maps NoChaptersInRangeError → CONFIG_ERROR (2)", () => {
      expect(mapErrorToExitCode(new NoChaptersInRangeError(100, "latest"))).toBe(ExitCode.CONFIG_ERROR);
    });
  });

  describe("CF unsolvable → 3", () => {
    it("maps CfUnsolvableError → CF_UNSOLVABLE (3)", () => {
      expect(mapErrorToExitCode(new CfUnsolvableError("ERR_CF_UNSOLVABLE"))).toBe(ExitCode.CF_UNSOLVABLE);
    });
  });

  describe("source / adapter errors → 4", () => {
    it("maps NextDataNotFoundError → SOURCE_NOT_FOUND (4)", () => {
      expect(mapErrorToExitCode(new NextDataNotFoundError("http://example.com"))).toBe(ExitCode.SOURCE_NOT_FOUND);
    });

    it("maps LilianaParseError → SOURCE_NOT_FOUND (4)", () => {
      expect(mapErrorToExitCode(new LilianaParseError("http://example.com"))).toBe(ExitCode.SOURCE_NOT_FOUND);
    });

    it("maps SlugMutationUnrecoverableError → SOURCE_NOT_FOUND (4)", () => {
      expect(mapErrorToExitCode(new SlugMutationUnrecoverableError(42, "http://example.com", "no match"))).toBe(ExitCode.SOURCE_NOT_FOUND);
    });
  });

  describe("rate limit → 5", () => {
    it("maps RateLimitExhaustedError → PARTIAL_RESUME_POSSIBLE (5)", () => {
      expect(mapErrorToExitCode(new RateLimitExhaustedError("example.com"))).toBe(ExitCode.PARTIAL_RESUME_POSSIBLE);
    });
  });

  describe("IO / image format errors → 6", () => {
    it("maps InvalidImageFormatError → IO_ERROR (6)", () => {
      expect(mapErrorToExitCode(new InvalidImageFormatError("application/octet-stream"))).toBe(ExitCode.IO_ERROR);
    });
  });

  describe("abort errors", () => {
    it("maps AbortError (graceful) → USER_ABORT (7)", () => {
      expect(mapErrorToExitCode(new AbortError("aborted"))).toBe(ExitCode.USER_ABORT);
    });

    it("maps AbortError (forced) → INT_SIGINT (130)", () => {
      expect(mapErrorToExitCode(new AbortError("aborted"), true)).toBe(ExitCode.INT_SIGINT);
    });

    it("maps native AbortError (name='AbortError') → USER_ABORT (7) when graceful", () => {
      const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      expect(mapErrorToExitCode(err)).toBe(ExitCode.USER_ABORT);
    });

    it("maps native AbortError (name='AbortError') → INT_SIGINT (130) when forced", () => {
      const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      expect(mapErrorToExitCode(err, true)).toBe(ExitCode.INT_SIGINT);
    });
  });

  describe("generic Error → 1", () => {
    it("maps generic Error → GENERIC (1)", () => {
      expect(mapErrorToExitCode(new Error("something broke"))).toBe(ExitCode.GENERIC);
    });

    it("maps unknown thrown string → GENERIC (1)", () => {
      expect(mapErrorToExitCode("a string was thrown")).toBe(ExitCode.GENERIC);
    });

    it("maps thrown null → GENERIC (1)", () => {
      expect(mapErrorToExitCode(null)).toBe(ExitCode.GENERIC);
    });

    it("maps thrown object → GENERIC (1)", () => {
      expect(mapErrorToExitCode({ message: "weird" })).toBe(ExitCode.GENERIC);
    });
  });
});
