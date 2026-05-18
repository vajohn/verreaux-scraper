// ---------------------------------------------------------------------------
// manhuaplus.helpers.test.ts — unit tests for Liliana-theme parse helpers.
//
// Fixtures loaded from test/fixtures/manhuaplus-liliana/ (captured from live site).
// No network calls are made.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSeriesMetadata,
  parseChapterList,
  extractChapterId,
  parseImageListResponse,
  extractChapterNumber,
  LilianaParseError,
} from "../src/adapters/manhuaplus.helpers.js";
import type { ImageListResponse } from "../src/adapters/manhuaplus.helpers.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures/manhuaplus-liliana", name),
    "utf8",
  );
}

function fixtureJson<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

const ORIGIN = "https://manhuaplus.org";

// ---------------------------------------------------------------------------
// parseSeriesMetadata
// ---------------------------------------------------------------------------

describe("parseSeriesMetadata", () => {
  it("extracts the correct title from the liliana series page", () => {
    const html = fixture("series.html");
    const meta = parseSeriesMetadata(html);
    expect(meta.title).toBe(
      "The Third Prince of the Fallen Kingdom has Regressed",
    );
  });

  it("extracts the cover URL from og:image meta", () => {
    const html = fixture("series.html");
    const meta = parseSeriesMetadata(html);
    expect(meta.coverUrl).toBe(
      "https://manhuaplus.org/uploads/covers/the-third-prince-of-the-fallen-kingdom-has-regressed.jpg",
    );
  });

  it("throws LilianaParseError when h1.mt-0.mb-6.fs-20 is absent", () => {
    const html = `<html><body><p>No title here</p></body></html>`;
    expect(() => parseSeriesMetadata(html)).toThrow(LilianaParseError);
  });

  it("throw message mentions the selector for diagnosability", () => {
    const html = `<html><body></body></html>`;
    let msg = "";
    try {
      parseSeriesMetadata(html);
    } catch (err) {
      msg = err instanceof Error ? err.message : "";
    }
    expect(msg).toMatch(/h1\.mt-0\.mb-6\.fs-20/);
  });
});

// ---------------------------------------------------------------------------
// parseChapterList
// ---------------------------------------------------------------------------

describe("parseChapterList", () => {
  it("parses 71 chapters from the live series fixture (chapter 0 through chapter 70)", () => {
    const html = fixture("series.html");
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toHaveLength(71);
  });

  it("chapter list contains chapter 0 (lowest)", () => {
    const html = fixture("series.html");
    const chapters = parseChapterList(html, ORIGIN);
    const byNumber = new Map(chapters.map((c) => [c.number, c]));
    const ch0 = byNumber.get(0);
    expect(ch0).toBeDefined();
    expect(ch0?.url).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-0",
    );
  });

  it("chapter list contains chapter 70 (highest in fixture)", () => {
    const html = fixture("series.html");
    const chapters = parseChapterList(html, ORIGIN);
    const byNumber = new Map(chapters.map((c) => [c.number, c]));
    const ch70 = byNumber.get(70);
    expect(ch70).toBeDefined();
    expect(ch70?.url).toBe(
      "https://manhuaplus.org/manga/the-third-prince-of-the-fallen-kingdom-has-regressed/chapter-70",
    );
  });

  it("returns chapters in DOM order (newest-first — chapter 70 appears before chapter 0)", () => {
    const html = fixture("series.html");
    const chapters = parseChapterList(html, ORIGIN);
    const numbers = chapters.map((c) => c.number);
    const idxFirst = numbers[0];
    const idxLast = numbers[numbers.length - 1];
    // Newest-first: first entry has a higher number than the last entry
    expect(idxFirst).toBeGreaterThan(idxLast!);
  });

  it("deduplicates chapters with the same number", () => {
    const html = `<html><body><ul>
      <li class="chapter"><a href="https://manhuaplus.org/manga/s/chapter-1">Chapter 1</a></li>
      <li class="chapter"><a href="https://manhuaplus.org/manga/s/chapter-1">Chapter 1</a></li>
    </ul></body></html>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toHaveLength(1);
  });

  it("resolves relative hrefs against origin", () => {
    const html = `<html><body><ul>
      <li class="chapter"><a href="/manga/s/chapter-5">Chapter 5</a></li>
    </ul></body></html>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters[0]?.url).toBe("https://manhuaplus.org/manga/s/chapter-5");
  });

  it("skips entries with no href", () => {
    const html = `<html><body><ul>
      <li class="chapter"><a>Chapter 1</a></li>
      <li class="chapter"><a href="https://manhuaplus.org/manga/s/chapter-2">Chapter 2</a></li>
    </ul></body></html>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.number).toBe(2);
  });

  it("returns empty array when no li.chapter elements found", () => {
    const html = `<html><body><p>No chapters</p></body></html>`;
    expect(parseChapterList(html, ORIGIN)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractChapterId
// ---------------------------------------------------------------------------

describe("extractChapterId", () => {
  it("extracts CHAPTER_ID = 78093 from the live chapter fixture", () => {
    const html = fixture("chapter.html");
    expect(extractChapterId(html)).toBe(78093);
  });

  it("returns null when CHAPTER_ID is absent", () => {
    const html = `<html><body><script>var OTHER = 1;</script></body></html>`;
    expect(extractChapterId(html)).toBeNull();
  });

  it("handles whitespace around the assignment operator", () => {
    const html = `<script>var CHAPTER_ID  =  99;</script>`;
    expect(extractChapterId(html)).toBe(99);
  });

  it("returns null for empty HTML", () => {
    expect(extractChapterId("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseImageListResponse
// ---------------------------------------------------------------------------

describe("parseImageListResponse", () => {
  it("extracts 7 image URLs from the live image-list fixture", () => {
    const json = fixtureJson<ImageListResponse>("image-list.json");
    const urls = parseImageListResponse(json);
    expect(urls).toHaveLength(7);
  });

  it("all image URLs come from cdn.manhuaplus.cc", () => {
    const json = fixtureJson<ImageListResponse>("image-list.json");
    const urls = parseImageListResponse(json);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/cdn\.manhuaplus\.cc\//);
    }
  });

  it("images are sorted by data-index (0, 1, 2, ... order)", () => {
    const json = fixtureJson<ImageListResponse>("image-list.json");
    const urls = parseImageListResponse(json);
    // data-index values in the fixture are 4, 6, 0, 2, 1, 3, 5 (server order)
    // After sort: 0, 1, 2, 3, 4, 5, 6
    // index 0 image
    expect(urls[0]).toContain("04-28-04");
    // index 1 image
    expect(urls[1]).toContain("04-28-06");
  });

  it("returns empty array when status is false", () => {
    const json: ImageListResponse = { status: false, html: "<img src='https://cdn.manhuaplus.cc/img.jpg'>" };
    expect(parseImageListResponse(json)).toHaveLength(0);
  });

  it("returns empty array when html is empty string", () => {
    const json: ImageListResponse = { status: true, html: "" };
    expect(parseImageListResponse(json)).toHaveLength(0);
  });

  it("ignores placeholder src values (non-http)", () => {
    const json: ImageListResponse = {
      status: true,
      html: `<div data-index="0"><img src="/themes/liliana/images/Loading/loading.gif" data-src="https://cdn.manhuaplus.cc/real.jpg"></div>`,
    };
    // The placeholder is a relative path — parseImageListResponse should skip it
    // (data-src is the placeholder in liliana; src= is what we parse, but relative paths
    // starting with "/" are filtered out by the startsWith("http") check)
    const urls = parseImageListResponse(json);
    expect(urls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractChapterNumber
// ---------------------------------------------------------------------------

describe("extractChapterNumber", () => {
  it('parses "Chapter 0"', () => {
    expect(extractChapterNumber("Chapter 0")).toBe(0);
  });

  it('parses "Chapter 1"', () => {
    expect(extractChapterNumber("Chapter 1")).toBe(1);
  });

  it('parses "Chapter 01" (zero-padded)', () => {
    expect(extractChapterNumber("Chapter 01")).toBe(1);
  });

  it('parses "Ch. 1.5" (decimal)', () => {
    expect(extractChapterNumber("Ch. 1.5")).toBe(1.5);
  });

  it('parses "Chapter 03 - Title" (with suffix)', () => {
    expect(extractChapterNumber("Chapter 03 - Title")).toBe(3);
  });

  it('parses "Chapter 70" (large integer)', () => {
    expect(extractChapterNumber("Chapter 70")).toBe(70);
  });

  it("returns NaN for text with no recognisable number", () => {
    expect(extractChapterNumber("Prologue")).toBeNaN();
  });
});
