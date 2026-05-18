// ---------------------------------------------------------------------------
// drake.helpers.test.ts — unit tests for the drakecomic.org parser.
//
// Fixtures captured from drakecomic.org on 2026-05-18 live in
// test/fixtures/drake/. No network calls are made here.
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
  DrakeParseError,
  type TsReaderConfig,
} from "../src/adapters/drake.helpers.js";

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, "fixtures/drake", name),
    "utf8",
  );
}

const ORIGIN = "https://drakecomic.org";

// ---------------------------------------------------------------------------
// parseSeriesMetadata
// ---------------------------------------------------------------------------

describe("parseSeriesMetadata (drake)", () => {
  it("extracts the title from the Themesia series page", () => {
    const meta = parseSeriesMetadata(fixture("series.html"));
    expect(meta.title).toBe("Logging 10,000 Years into the Future");
  });

  it("extracts the cover URL from div.thumb img (og:image is the site logo)", () => {
    const meta = parseSeriesMetadata(fixture("series.html"));
    expect(meta.coverUrl).toBe(
      "https://drakecomic.org/wp-content/uploads/2025/09/aagWOY-m.jpg",
    );
  });

  it("throws DrakeParseError when h1.entry-title is absent", () => {
    const html = `<html><body><p>No title</p></body></html>`;
    expect(() => parseSeriesMetadata(html)).toThrow(DrakeParseError);
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

describe("parseChapterList (drake)", () => {
  it("returns chapters in newest-first DOM order", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    expect(chapters.length).toBeGreaterThan(0);
    expect(chapters[0]!.number).toBeGreaterThan(chapters[chapters.length - 1]!.number);
  });

  it("parses 322 unique chapters from the captured fixture", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    expect(chapters.length).toBe(322);
  });

  it("includes chapter 320 (most-recent at capture time) with absolute URL", () => {
    const chapters = parseChapterList(fixture("series.html"), ORIGIN);
    const ch320 = chapters.find((c) => c.number === 320);
    expect(ch320).toBeDefined();
    expect(ch320!.url).toBe(
      "https://drakecomic.org/logging-10000-years-into-the-future-chapter-320/",
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
          <a href="/logging-10000-years-into-the-future-chapter-42/">
            <span class="chapternum">Chapter 9000</span>
          </a>
        </li>
      </ul>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters).toEqual([
      {
        number: 42,
        url: "https://drakecomic.org/logging-10000-years-into-the-future-chapter-42/",
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
      { number: 7, url: "https://drakecomic.org/foo-chapter-7/" },
    ]);
  });

  it("returns absolute URLs unchanged", () => {
    const html = `
      <ul id="chapterlist">
        <li data-num="1">
          <a href="https://drakecomic.org/x-chapter-1/"><span class="chapternum">Chapter 1</span></a>
        </li>
      </ul>`;
    const chapters = parseChapterList(html, ORIGIN);
    expect(chapters[0]!.url).toBe("https://drakecomic.org/x-chapter-1/");
  });
});

// ---------------------------------------------------------------------------
// extractTsReaderConfig + pickImageList
// ---------------------------------------------------------------------------

describe("extractTsReaderConfig (drake)", () => {
  it("parses the ts_reader.run JSON literal from a real chapter page", () => {
    const cfg = extractTsReaderConfig(fixture("chapter.html"));
    expect(cfg).not.toBeNull();
    expect(cfg!.post_id).toBe(10168);
    expect(cfg!.sources.length).toBeGreaterThan(0);
    expect(cfg!.sources[0]!.source).toBe("Server 1");
  });

  it("yields 17 image URLs for the captured chapter", () => {
    const cfg = extractTsReaderConfig(fixture("chapter.html"))!;
    const images = pickImageList(cfg);
    expect(images.length).toBe(17);
    expect(images[0]).toBe(
      "https://drakecomic.org/wp-content/uploads/2025/09/001-160.webp",
    );
    expect(images[16]).toBe(
      "https://drakecomic.org/wp-content/uploads/2025/09/017-133.webp",
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

describe("pickImageList (drake)", () => {
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

describe("extractChapterNumber (drake)", () => {
  it.each([
    ["Chapter 0", 0],
    ["Chapter 1", 1],
    ["Chapter 01", 1],
    ["Ch. 1.5", 1.5],
    ["Chapter 03 - Title", 3],
    ["Chapter 320", 320],
  ])("parses %j → %d", (input, expected) => {
    expect(extractChapterNumber(input)).toBe(expected);
  });

  it("returns NaN for non-numeric text", () => {
    expect(extractChapterNumber("garbage")).toBeNaN();
  });
});
