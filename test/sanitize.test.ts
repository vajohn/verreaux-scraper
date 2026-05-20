import { describe, it, expect } from "vitest";
import {
  sanitizeSeriesName,
  formatChapterFolder,
  formatPageFilename,
  pickCoverFilename,
} from "../src/packaging/sanitize.js";

// ---------------------------------------------------------------------------
// sanitizeSeriesName
// ---------------------------------------------------------------------------

describe("sanitizeSeriesName", () => {
  it("passes through a normal series title unchanged", () => {
    expect(sanitizeSeriesName("Solo Leveling")).toBe("Solo Leveling");
  });

  it("replaces backslash with underscore", () => {
    expect(sanitizeSeriesName("Series\\Name")).toBe("Series_Name");
  });

  it("replaces forward slash with underscore", () => {
    expect(sanitizeSeriesName("A/B")).toBe("A_B");
  });

  it("replaces colon with underscore", () => {
    expect(sanitizeSeriesName("Series: The Return")).toBe("Series_ The Return");
  });

  it("replaces all Windows-illegal characters", () => {
    const input = 'test*?:"<>|name';
    const result = sanitizeSeriesName(input);
    expect(result).not.toMatch(/[*?"<>|:]/);
  });

  it("collapses multiple spaces to one", () => {
    expect(sanitizeSeriesName("A  B   C")).toBe("A B C");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeSeriesName("  Tower of God  ")).toBe("Tower of God");
  });

  it("removes trailing dot (Windows quirk)", () => {
    expect(sanitizeSeriesName("Series.")).toBe("Series");
  });

  it("removes multiple trailing dots", () => {
    expect(sanitizeSeriesName("Series...")).toBe("Series");
  });

  it("does not remove dots in the middle", () => {
    expect(sanitizeSeriesName("S.S. Rajamouli's Work")).toBe(
      "S.S. Rajamouli's Work",
    );
  });

  it("truncates to 200 characters exactly", () => {
    const long = "A".repeat(250);
    const result = sanitizeSeriesName(long);
    expect(result.length).toBe(200);
  });

  it("handles an empty string without throwing", () => {
    expect(sanitizeSeriesName("")).toBe("");
  });

  it("handles a string that is all illegal chars", () => {
    const result = sanitizeSeriesName('\\/:*?"<>|');
    // All replaced with underscores, then trim
    expect(result).toBe("_________");
  });

  it("handles a string that becomes empty after sanitization", () => {
    // Trailing-dot-only becomes empty after stripping
    expect(sanitizeSeriesName(".")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatChapterFolder
// ---------------------------------------------------------------------------

describe("formatChapterFolder", () => {
  it("formats integer chapter with 3-digit padding", () => {
    expect(formatChapterFolder(1)).toBe("Chapter 001");
    expect(formatChapterFolder(42)).toBe("Chapter 042");
    expect(formatChapterFolder(999)).toBe("Chapter 999");
  });

  it("formats decimal chapter preserving the fractional part", () => {
    expect(formatChapterFolder(1.5)).toBe("Chapter 001.5");
    expect(formatChapterFolder(12.5)).toBe("Chapter 012.5");
  });

  it("uses padWidth=4 when caller specifies", () => {
    expect(formatChapterFolder(1, undefined, 4)).toBe("Chapter 0001");
    expect(formatChapterFolder(1000, undefined, 4)).toBe("Chapter 1000");
  });

  it("appends a non-trivial title", () => {
    expect(formatChapterFolder(5, "Tower of Blood")).toBe(
      "Chapter 005: Tower of Blood",
    );
  });

  it("omits title if it is a chapter-restatement pattern", () => {
    expect(formatChapterFolder(5, "Chapter 5")).toBe("Chapter 005");
    expect(formatChapterFolder(5, "Chapter 5.0")).toBe("Chapter 005");
    expect(formatChapterFolder(5, "Ch 5")).toBe("Chapter 005");
    expect(formatChapterFolder(5, "Ch. 5")).toBe("Chapter 005");
  });

  it("omits title if it is empty or whitespace", () => {
    expect(formatChapterFolder(3, "")).toBe("Chapter 003");
    expect(formatChapterFolder(3, "   ")).toBe("Chapter 003");
  });

  it("sanitizes illegal characters in title", () => {
    const result = formatChapterFolder(7, 'The Dark: "Knight"');
    expect(result).toBe("Chapter 007: The Dark_ _Knight_");
  });

  it("extractSortKey of result equals order (integer)", () => {
    // This is the importer-compatibility assertion
    const folder = formatChapterFolder(42);
    const match = folder.match(/(\d+)(?:\.(\d+))?/);
    expect(match).not.toBeNull();
    const key = match![2]
      ? parseFloat(`${match![1]}.${match![2]}`)
      : parseInt(match![1]!, 10);
    expect(key).toBe(42);
  });

  it("extractSortKey of result equals order (decimal)", () => {
    const folder = formatChapterFolder(12.5);
    const match = folder.match(/(\d+)(?:\.(\d+))?/);
    expect(match).not.toBeNull();
    const key = match![2]
      ? parseFloat(`${match![1]}.${match![2]}`)
      : parseInt(match![1]!, 10);
    expect(key).toBe(12.5);
  });
});

// ---------------------------------------------------------------------------
// formatPageFilename
// ---------------------------------------------------------------------------

describe("formatPageFilename", () => {
  it("produces 3-digit zero-padded filename", () => {
    expect(formatPageFilename(1, ".png")).toBe("001.png");
    expect(formatPageFilename(42, ".webp")).toBe("042.webp");
    expect(formatPageFilename(999, ".jpg")).toBe("999.jpg");
  });

  it("handles ext without leading dot", () => {
    expect(formatPageFilename(1, "png")).toBe("001.png");
  });

  it("normalises ext to lowercase", () => {
    expect(formatPageFilename(1, ".PNG")).toBe("001.png");
    expect(formatPageFilename(1, ".WEBP")).toBe("001.webp");
  });

  it("uses padWidth=4 when specified", () => {
    expect(formatPageFilename(1, ".png", 4)).toBe("0001.png");
    expect(formatPageFilename(1000, ".png", 4)).toBe("1000.png");
  });

  it("extractSortKey of stem equals pageNumber", () => {
    const filename = formatPageFilename(42, ".png");
    const stem = filename.slice(0, filename.lastIndexOf("."));
    const key = parseInt(stem, 10);
    expect(key).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// pickCoverFilename
// ---------------------------------------------------------------------------

describe("pickCoverFilename", () => {
  it("maps image/webp → cover.webp", () => {
    expect(pickCoverFilename("image/webp")).toBe("cover.webp");
  });

  it("maps image/jpeg → cover.jpeg", () => {
    expect(pickCoverFilename("image/jpeg")).toBe("cover.jpeg");
  });

  it("maps image/jpg → cover.jpg", () => {
    // Some servers send this non-standard mime
    expect(pickCoverFilename("image/jpg")).toBe("cover.jpg");
  });

  it("maps image/png → cover.png", () => {
    expect(pickCoverFilename("image/png")).toBe("cover.png");
  });

  it("maps image/svg+xml → cover.svg", () => {
    expect(pickCoverFilename("image/svg+xml")).toBe("cover.svg");
  });

  it("falls back to cover.png for unknown mime", () => {
    expect(pickCoverFilename("application/octet-stream")).toBe("cover.png");
  });

  it("result always matches the importer COVER_RE", () => {
    const COVER_RE = /^cover\.(webp|jpg|jpeg|png|svg)$/i;
    const mimes = [
      "image/webp",
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/svg+xml",
      "application/octet-stream",
    ];
    for (const mime of mimes) {
      expect(pickCoverFilename(mime)).toMatch(COVER_RE);
    }
  });
});
