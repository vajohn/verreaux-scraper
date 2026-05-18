// ---------------------------------------------------------------------------
// asurascans.helpers.test.ts — pure-function tests against live-captured
// Astro v5 fixtures from asurascans.com (captured 2026-05-16).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSeriesPage,
  parseChapterPage,
  parseSlugAndHash,
  buildChapterUrl,
  isNsfwSplash,
  extractAstroPageJson,
  SlugParseError,
  NextDataNotFoundError,
} from "../src/adapters/asurascans.helpers.js";

const FIXTURES_ASTRO = join(import.meta.dirname ?? __dirname, "fixtures", "asurascans-astro");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_ASTRO, name), "utf8");
}

// ---------------------------------------------------------------------------
// parseSlugAndHash
// ---------------------------------------------------------------------------

describe("parseSlugAndHash", () => {
  it("parses the canonical /comics/ URL correctly", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a",
    );
    expect(result.slug).toBe("the-max-level-players-100th-regression");
    expect(result.hash).toBe("030ff47a");
  });

  it("parses a /series/ path URL (legacy alias)", () => {
    const result = parseSlugAndHash(
      "https://asuracomic.net/series/the-max-level-players-100th-regression-030ff47a",
    );
    expect(result.slug).toBe("the-max-level-players-100th-regression");
    expect(result.hash).toBe("030ff47a");
  });

  it("parses a /manga/ path URL", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/manga/some-manga-abc123",
    );
    expect(result.slug).toBe("some-manga");
    expect(result.hash).toBe("abc123");
  });

  it("parses a /manhua/ path URL", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/manhua/some-manhua-deadbeef",
    );
    expect(result.slug).toBe("some-manhua");
    expect(result.hash).toBe("deadbeef");
  });

  it("parses a URL with a chapter suffix", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/42",
    );
    expect(result.slug).toBe("the-max-level-players-100th-regression");
    expect(result.hash).toBe("030ff47a");
  });

  it("parses a path-only string (no host)", () => {
    const result = parseSlugAndHash("/comics/my-hero-academia-deadbeef/chapter/1");
    expect(result.slug).toBe("my-hero-academia");
    expect(result.hash).toBe("deadbeef");
  });

  it("parses a hash that is 6 hex chars (minimum length)", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/comics/some-series-ff00ab",
    );
    expect(result.slug).toBe("some-series");
    expect(result.hash).toBe("ff00ab");
  });

  it("parses a hash that is 12 hex chars (maximum length)", () => {
    const result = parseSlugAndHash(
      "https://asurascans.com/comics/some-series-aabbccddeeff",
    );
    expect(result.slug).toBe("some-series");
    expect(result.hash).toBe("aabbccddeeff");
  });

  it("throws SlugParseError on a path with no hash", () => {
    expect(() => parseSlugAndHash("/comics/no-hash-here")).toThrow(SlugParseError);
  });

  it("throws SlugParseError when hash contains non-hex characters", () => {
    expect(() =>
      parseSlugAndHash("https://asurascans.com/comics/some-series-zzzzzzz"),
    ).toThrow(SlugParseError);
  });

  it("throws SlugParseError on completely malformed input", () => {
    expect(() => parseSlugAndHash("not-a-url-and-not-a-path")).toThrow(SlugParseError);
  });

  it("throws SlugParseError on an empty string", () => {
    expect(() => parseSlugAndHash("")).toThrow(SlugParseError);
  });

  it("preserves hash value exactly without transformation", () => {
    const { hash } = parseSlugAndHash(
      "https://asurascans.com/comics/test-series-030ff47a",
    );
    expect(hash).toBe("030ff47a");
  });
});

// ---------------------------------------------------------------------------
// buildChapterUrl
// ---------------------------------------------------------------------------

describe("buildChapterUrl", () => {
  it("builds the canonical /comics/ URL", () => {
    const url = buildChapterUrl(
      "asurascans.com",
      "the-max-level-players-100th-regression",
      "030ff47a",
      83,
    );
    expect(url).toBe(
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/83",
    );
  });

  it("uses /comics/ not /series/", () => {
    const url = buildChapterUrl("asurascans.com", "slug", "abc123", 1);
    expect(url).toContain("/comics/");
    expect(url).not.toContain("/series/");
  });

  it("handles chapter 0 (prologue)", () => {
    const url = buildChapterUrl(
      "asurascans.com",
      "the-max-level-players-100th-regression",
      "030ff47a",
      0,
    );
    expect(url).toBe(
      "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/0",
    );
  });

  it("handles decimal chapter numbers without adding .0", () => {
    const url = buildChapterUrl("asurascans.com", "some-series", "abc123", 10.5);
    expect(url).toContain("/chapter/10.5");
    expect(url).not.toContain("/chapter/10.50");
  });

  it("integer chapters have no trailing .0", () => {
    const url = buildChapterUrl("asurascans.com", "test", "aabbcc", 42);
    expect(url).toContain("/chapter/42");
    expect(url).not.toContain("/chapter/42.0");
  });

  it("includes the hash exactly as supplied", () => {
    const url = buildChapterUrl("asurascans.com", "slug", "030ff47a", 5);
    expect(url).toContain("030ff47a");
  });

  it("matches the URL pattern verified in real HTML", () => {
    // Verified: https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a/chapter/83
    const url = buildChapterUrl(
      "asurascans.com",
      "the-max-level-players-100th-regression",
      "030ff47a",
      83,
    );
    expect(url).toMatch(
      /^https:\/\/asurascans\.com\/comics\/the-max-level-players-100th-regression-030ff47a\/chapter\/83$/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseSeriesPage — against live-captured series.html fixture
// ---------------------------------------------------------------------------

describe("parseSeriesPage", () => {
  const SOURCE_URL =
    "https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a";

  let result: ReturnType<typeof parseSeriesPage>;

  // Parse once and share across assertions (fixture is 189 KB — no need to re-parse).
  beforeAll(() => {
    result = parseSeriesPage(fixture("series.html"), SOURCE_URL);
  });

  it("returns the correct series title", () => {
    expect(result.title).toBe("The Max-Level Player's 100th Regression");
  });

  it("returns the correct slug", () => {
    expect(result.slug).toBe("the-max-level-players-100th-regression");
  });

  it("returns the correct hash", () => {
    expect(result.hash).toBe("030ff47a");
  });

  it("returns the cover URL from cdn.asurascans.com", () => {
    expect(result.coverUrl).not.toBeNull();
    expect(result.coverUrl).toContain("cdn.asurascans.com");
    expect(result.coverUrl).toContain("asura-images/covers/");
  });

  it("returns exactly 84 chapters (0 through 83)", () => {
    expect(result.chapters.length).toBe(84);
  });

  it("includes chapter 0 (prologue)", () => {
    const chap0 = result.chapters.find((c) => c.chapterNumber === 0);
    expect(chap0).toBeDefined();
  });

  it("includes chapter 83 (latest)", () => {
    const chap83 = result.chapters.find((c) => c.chapterNumber === 83);
    expect(chap83).toBeDefined();
  });

  it("chapter numbers span 0..83 with no gaps", () => {
    const numbers = result.chapters.map((c) => c.chapterNumber).sort((a, b) => a - b);
    for (let i = 0; i <= 83; i++) {
      expect(numbers[i]).toBe(i);
    }
  });

  it("chapter slugs reference /chapter/<N> format", () => {
    const chap1 = result.chapters.find((c) => c.chapterNumber === 1);
    expect(chap1?.chapterSlug).toMatch(/chapter-1/);
  });
});

// ---------------------------------------------------------------------------
// parseChapterPage — against live-captured chapter.html fixture (chapter 0)
// ---------------------------------------------------------------------------

describe("parseChapterPage", () => {
  let result: ReturnType<typeof parseChapterPage>;

  beforeAll(() => {
    result = parseChapterPage(fixture("chapter.html"));
  });

  it("returns ≥ 20 image URLs", () => {
    expect(result.imageUrls.length).toBeGreaterThanOrEqual(20);
  });

  it("returns exactly 24 image URLs (chapter 0 has 24 pages)", () => {
    expect(result.imageUrls.length).toBe(24);
  });

  it("every URL starts with https://cdn.asurascans.com/asura-images/chapters/", () => {
    for (const url of result.imageUrls) {
      expect(url).toMatch(/^https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\//);
    }
  });

  it("URLs are in ascending page order (NNN.webp pattern, NNN ascending)", () => {
    for (let i = 0; i < result.imageUrls.length - 1; i++) {
      const curr = result.imageUrls[i]!;
      const next = result.imageUrls[i + 1]!;
      // Extract the page number from the end of the URL: /NNN.webp
      const currNum = parseInt(curr.match(/\/(\d{3})\.webp$/)?.[1] ?? "0");
      const nextNum = parseInt(next.match(/\/(\d{3})\.webp$/)?.[1] ?? "0");
      expect(currNum).toBeLessThan(nextNum);
    }
  });

  it("first URL is page 001", () => {
    expect(result.imageUrls[0]).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/001.webp",
    );
  });

  it("second URL is page 002", () => {
    expect(result.imageUrls[1]).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/002.webp",
    );
  });

  it("third URL is page 003", () => {
    expect(result.imageUrls[2]).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/003.webp",
    );
  });

  it("fourth URL is page 004", () => {
    expect(result.imageUrls[3]).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/004.webp",
    );
  });

  it("fifth URL is page 005", () => {
    expect(result.imageUrls[4]).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/005.webp",
    );
  });

  it("last URL is page 024", () => {
    const last = result.imageUrls[result.imageUrls.length - 1];
    expect(last).toBe(
      "https://cdn.asurascans.com/asura-images/chapters/the-max-level-players-100th-regression/0/024.webp",
    );
  });

  it("no duplicate URLs", () => {
    const unique = new Set(result.imageUrls);
    expect(unique.size).toBe(result.imageUrls.length);
  });
});

// ---------------------------------------------------------------------------
// extractAstroPageJson — against live-captured chapter.html fixture
// ---------------------------------------------------------------------------

describe("extractAstroPageJson", () => {
  let result: string[] | null;

  beforeAll(() => {
    result = extractAstroPageJson(fixture("chapter.html"));
  });

  it("returns a non-null array", () => {
    expect(result).not.toBeNull();
  });

  it("returns ≥ 20 URLs", () => {
    expect(result!.length).toBeGreaterThanOrEqual(20);
  });

  it("returns exactly 24 URLs (matches DOM scan)", () => {
    expect(result!.length).toBe(24);
  });

  it("all URLs start with https://cdn.asurascans.com/asura-images/chapters/", () => {
    for (const url of result!) {
      expect(url).toMatch(/^https:\/\/cdn\.asurascans\.com\/asura-images\/chapters\//);
    }
  });

  it("returns null for HTML with no Astro island pages blob", () => {
    const plain = "<html><body><p>No Astro here</p></body></html>";
    expect(extractAstroPageJson(plain)).toBeNull();
  });

  it("URLs are identical to what parseChapterPage returns from the DOM", () => {
    const domResult = parseChapterPage(fixture("chapter.html"));
    // Both sources should agree; allow minor ordering differences by sorting.
    expect(result!.slice().sort()).toEqual(domResult.imageUrls.slice().sort());
  });
});

// ---------------------------------------------------------------------------
// isNsfwSplash — heuristic tests
// ---------------------------------------------------------------------------

describe("isNsfwSplash", () => {
  it("returns false for the real chapter fixture (CDN images present)", () => {
    expect(isNsfwSplash(fixture("chapter.html"))).toBe(false);
  });

  it("returns false for the real series fixture (no splash markers)", () => {
    expect(isNsfwSplash(fixture("series.html"))).toBe(false);
  });

  it("returns false for a plain page with no markers", () => {
    expect(isNsfwSplash("<html><body><p>Normal page</p></body></html>")).toBe(false);
  });

  it("returns true for mature content warning without CDN images", () => {
    const html =
      "<html><body><p>Mature content warning — 18+ only</p><button>Click to continue</button></body></html>";
    expect(isNsfwSplash(html)).toBe(true);
  });

  it("returns false when mature content AND cdn.asurascans.com images both present", () => {
    const html =
      "<html><body>" +
      "<p>This chapter contains mature content.</p>" +
      "<img src='https://cdn.asurascans.com/asura-images/chapters/series/0/001.webp'/>" +
      "</body></html>";
    expect(isNsfwSplash(html)).toBe(false);
  });

  it("returns false when mature content AND legacy gg.asuracomic.net images present", () => {
    const html =
      "<html><body>" +
      "<p>Adult content — confirm your age</p>" +
      "<img src='https://gg.asuracomic.net/storage/001.webp'/>" +
      "</body></html>";
    expect(isNsfwSplash(html)).toBe(false);
  });

  it("is case-insensitive for splash markers", () => {
    const html = "<html><body><p>ADULT CONTENT - AGE VERIFICATION REQUIRED</p></body></html>";
    expect(isNsfwSplash(html)).toBe(true);
  });

  it("safe_browse marker triggers detection", () => {
    const html = "<html><body><input name='safe_browse' value='1'/></body></html>";
    expect(isNsfwSplash(html)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NextDataNotFoundError — kept for API compatibility with cli.errorMap.ts
// ---------------------------------------------------------------------------

describe("NextDataNotFoundError (compatibility export)", () => {
  it("is exported and constructable", () => {
    const err = new NextDataNotFoundError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NextDataNotFoundError");
    expect(err.message).toBe("test");
  });

  it("has the correct default message", () => {
    const err = new NextDataNotFoundError();
    expect(err.message).toContain("Astro");
  });
});
