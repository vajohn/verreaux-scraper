import { describe, it, expect } from "vitest";
import { selectChapters, EmptyRangeError, NoChaptersInRangeError } from "../src/core/selectRange.js";
import type { ChapterMeta } from "../src/core/types.js";

function makeChapters(numbers: number[]): ChapterMeta[] {
  return numbers.map((n, i) => ({
    canonicalChapterId: `series:ch${n}`,
    number: n,
    title: `Chapter ${n}`,
    urlAtRun: `https://example.com/ch/${n}`,
    order: i,
  }));
}

describe("selectChapters", () => {
  const chapters = makeChapters([1, 2, 3, 4, 5, 10, 20]);

  it("returns all chapters when no args (defaults to from=0, to=latest)", () => {
    const result = selectChapters(chapters);
    expect(result.map((c) => c.number)).toEqual([1, 2, 3, 4, 5, 10, 20]);
  });

  it("filters from lower bound inclusive", () => {
    const result = selectChapters(chapters, 3);
    expect(result.map((c) => c.number)).toEqual([3, 4, 5, 10, 20]);
  });

  it("filters to upper bound inclusive", () => {
    const result = selectChapters(chapters, 0, 5);
    expect(result.map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("filters both from and to inclusive", () => {
    const result = selectChapters(chapters, 2, 5);
    expect(result.map((c) => c.number)).toEqual([2, 3, 4, 5]);
  });

  it("handles 'latest' as upper bound (includes all)", () => {
    const result = selectChapters(chapters, 10, "latest");
    expect(result.map((c) => c.number)).toEqual([10, 20]);
  });

  it("returns a single chapter when from === to", () => {
    const result = selectChapters(chapters, 3, 3);
    expect(result.map((c) => c.number)).toEqual([3]);
  });

  it("returns results sorted by chapter number ascending regardless of input order", () => {
    const unsorted = makeChapters([5, 3, 1, 4, 2]);
    const result = selectChapters(unsorted, 0, "latest");
    expect(result.map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles decimal chapter numbers", () => {
    const withDecimals = makeChapters([1, 1.5, 2, 2.5]);
    const result = selectChapters(withDecimals, 1.5, 2);
    expect(result.map((c) => c.number)).toEqual([1.5, 2]);
  });

  it("throws EmptyRangeError when from > to (numeric)", () => {
    expect(() => selectChapters(chapters, 10, 5)).toThrow(EmptyRangeError);
  });

  it("EmptyRangeError has correct code", () => {
    let caught: unknown;
    try {
      selectChapters(chapters, 10, 5);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmptyRangeError);
    expect((caught as EmptyRangeError).code).toBe("ERR_EMPTY_RANGE");
  });

  it("throws NoChaptersInRangeError when range is valid but no chapters match", () => {
    expect(() => selectChapters(chapters, 100, 200)).toThrow(NoChaptersInRangeError);
  });

  it("NoChaptersInRangeError has correct code", () => {
    let caught: unknown;
    try {
      selectChapters(chapters, 100, 200);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoChaptersInRangeError);
    expect((caught as NoChaptersInRangeError).code).toBe("ERR_NO_CHAPTERS_IN_RANGE");
  });

  it("throws NoChaptersInRangeError on empty chapters array with any range", () => {
    expect(() => selectChapters([], 0, "latest")).toThrow(NoChaptersInRangeError);
  });

  it("from=0 includes chapters with number < 1", () => {
    const withZero = makeChapters([0, 1, 2]);
    const result = selectChapters(withZero, 0, 1);
    expect(result.map((c) => c.number)).toEqual([0, 1]);
  });

  describe("explicit chapter list", () => {
    it("selects only the listed chapters", () => {
      const result = selectChapters(chapters, 0, "latest", [2, 4, 20]);
      expect(result.map((c) => c.number)).toEqual([2, 4, 20]);
    });

    it("ignores from/to when an explicit list is provided", () => {
      const result = selectChapters(chapters, 100, 200, [1, 3, 5]);
      expect(result.map((c) => c.number)).toEqual([1, 3, 5]);
    });

    it("returns results sorted ascending regardless of input list order", () => {
      const result = selectChapters(chapters, 0, "latest", [20, 1, 10]);
      expect(result.map((c) => c.number)).toEqual([1, 10, 20]);
    });

    it("silently drops requested chapters that don't exist in the source", () => {
      const result = selectChapters(chapters, 0, "latest", [3, 999, 5]);
      expect(result.map((c) => c.number)).toEqual([3, 5]);
    });

    it("throws NoChaptersInRangeError when none of the listed chapters exist", () => {
      expect(() => selectChapters(chapters, 0, "latest", [99, 100])).toThrow(NoChaptersInRangeError);
    });
  });
});
