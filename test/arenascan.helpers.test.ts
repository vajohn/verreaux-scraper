// ---------------------------------------------------------------------------
// arenascan.helpers.test.ts — unit tests for the Themesia/MangaReader parser.
//
// Fixtures captured from arenascan.com on 2026-05-16 live in
// test/fixtures/arenascan/. No network calls are made here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSeriesMetadata,
  parseChapterList,
  extractTsReaderConfig,
  pickImageList,
  extractChapterNumber,
  ArenascanParseError,
  type TsReaderConfig,
} from "../src/adapters/arenascan.helpers.js";

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures/arenascan", name),
    "utf8",
  );
}

const ORIGIN = "https://arenascan.com";

// ---------------------------------------------------------------------------
// parseSeriesMetadata
// ---------------------------------------------------------------------------

describe("parseSeriesMetadata (arenascan)", () => {
  it("extracts the title from the Themesia series page", () => {
    const meta = parseSeriesMetadata(fixture("series.html"));
    expect(meta.title).toBe("The Lord of the Wheel of Destiny");
  });

  it("extracts the cover URL from og:image meta", () => {
    const meta = parseSeriesMetadata(fixture("series.html"));
    expect(meta.coverUrl).toBe(
      "https://arenascan.com/wp-content/uploads/2025/08/eca5f6a2-f250-466b-9e58-9ff36930f9f2.jpg",
    );
  });

  it("throws ArenascanParseError when h1.entry-title is absent", () => {
    const html = `<html><body><p>No title</p></body></html>`;
    expect(() => parseSeriesMetadata(html)).toThrow(ArenascanParseError);
  });

  it("error message names the missing selector", () => {
    let msg = "";
    try {
      parseSeriesMetadata("<html><body></body></html>");
    } catch (err) {
      msg = err instanceof Error ? err.message : "";
    }
    expect(msg).toMatch(/h1\.entry-title/);
  });
});

// ---------------------------------------------------------------------------
// parseChapterList
// ---------------------------------------------------------------------------

describe("parseChapterList (arenascan)", () => {
  it("returns chapters in newest-first DOM order", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    expect(chapters.length).toBeGreaterThan(0);
    expect(chapters[0]!.number).toBeGreaterThan(chapters[chapters.length - 1]!.number);
  });

  it("includes chapter 230 (most-recent at capture time)", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    const ch230 = chapters.find((c) => c.number === 230);
    expect(ch230).toBeDefined();
    expect(ch230!.url).toBe(
      "https://arenascan.com/the-lord-of-the-wheel-of-destiny-chapter-230/",
    );
  });

  it("includes chapter 226 with the correct URL", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    const ch226 = chapters.find((c) => c.number === 226);
    expect(ch226).toBeDefined();
    expect(ch226!.url).toBe(
      "https://arenascan.com/the-lord-of-the-wheel-of-destiny-chapter-226/",
    );
  });

  it("dedupes by chapter number", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    const numbers = chapters.map((c) => c.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("prefers data-num over link text when both are present", () => {
    const html = `
      <ul id="chapterlist">
        <li data-num="42">
          <a href="/the-lord-of-the-wheel-of-destiny-chapter-42/">
            <span class="chapternum">Chapter 9000</span>
          </a>
        </li>
      </ul>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toEqual([
      {
        number: 42,
        url: "https://arenascan.com/the-lord-of-the-wheel-of-destiny-chapter-42/",
      },
    ]);
  });

  it("falls back to link text when data-num is missing", () => {
    const html = `
      <ul id="chapterlist">
        <li>
          <a href="/foo-chapter-7/">
            <span class="chapternum">Chapter 7</span>
          </a>
        </li>
      </ul>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toEqual([
      { number: 7, url: "https://arenascan.com/foo-chapter-7/" },
    ]);
  });

  it("returns absolute URLs unchanged", () => {
    const html = `
      <ul id="chapterlist">
        <li data-num="1">
          <a href="https://arenascan.com/x-chapter-1/"><span class="chapternum">Chapter 1</span></a>
        </li>
      </ul>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters[0]!.url).toBe("https://arenascan.com/x-chapter-1/");
  });
});

// ---------------------------------------------------------------------------
// extractTsReaderConfig + pickImageList
// ---------------------------------------------------------------------------

describe("extractTsReaderConfig (arenascan)", () => {
  it("parses the ts_reader.run JSON literal from a real chapter page", () => {
    const cfg = extractTsReaderConfig(fixture("chapter-226.html"));
    expect(cfg).not.toBeNull();
    expect(cfg!.post_id).toBe(400004);
    expect(cfg!.sources.length).toBeGreaterThan(0);
    expect(cfg!.sources[0]!.source).toBe("Server 1");
  });

  it("yields 110 image URLs for chapter 226", () => {
    const cfg = extractTsReaderConfig(fixture("chapter-226.html"))!;
    const images = pickImageList(cfg);
    expect(images.length).toBe(110);
    expect(images[0]).toBe(
      "https://cdn.arenascan.com/arena-bucket/245249/226/001.jpg",
    );
    expect(images[109]).toBe(
      "https://cdn.arenascan.com/arena-bucket/245249/226/110.jpg",
    );
  });

  it("returns null when the inline script is absent", () => {
    expect(extractTsReaderConfig("<html></html>")).toBeNull();
  });

  it("returns null when the JSON literal is malformed", () => {
    const html = `<script>ts_reader.run({not json});</script>`;
    expect(extractTsReaderConfig(html)).toBeNull();
  });

  it("returns null when sources is not an array", () => {
    const html = `<script>ts_reader.run({"sources":"oops"});</script>`;
    expect(extractTsReaderConfig(html)).toBeNull();
  });
});

describe("pickImageList (arenascan)", () => {
  it("honours defaultSource when present", () => {
    const cfg: TsReaderConfig = {
      post_id: 1,
      defaultSource: "Server 2",
      sources: [
        { source: "Server 1", images: ["https://a/1.jpg"] },
        { source: "Server 2", images: ["https://b/1.jpg", "https://b/2.jpg"] },
      ],
    };
    expect(pickImageList(cfg)).toEqual(["https://b/1.jpg", "https://b/2.jpg"]);
  });

  it("falls back to the first non-empty source if defaultSource is empty", () => {
    const cfg: TsReaderConfig = {
      post_id: 1,
      defaultSource: "Server 1",
      sources: [
        { source: "Server 1", images: [] },
        { source: "Server 2", images: ["https://b/1.jpg"] },
      ],
    };
    expect(pickImageList(cfg)).toEqual(["https://b/1.jpg"]);
  });

  it("returns [] when every source is empty", () => {
    const cfg: TsReaderConfig = {
      post_id: 1,
      sources: [{ source: "Server 1", images: [] }],
    };
    expect(pickImageList(cfg)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractChapterNumber
// ---------------------------------------------------------------------------

describe("extractChapterNumber (arenascan)", () => {
  it.each([
    ["Chapter 0", 0],
    ["Chapter 1", 1],
    ["Chapter 01", 1],
    ["Ch. 1.5", 1.5],
    ["Chapter 03 - Title", 3],
    ["Chapter 226", 226],
  ])("parses %j → %d", (input, expected) => {
    expect(extractChapterNumber(input)).toBe(expected);
  });

  it("returns NaN for non-numeric text", () => {
    expect(extractChapterNumber("garbage")).toBeNaN();
  });
});
