import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSeriesMetadata,
  parseChapterList,
  parseReaderImages,
  extractChapterNumber,
  ManhwanexParseError,
} from "../src/adapters/manhwanex.helpers.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/manhwanex", name), "utf8");
}
const ORIGIN = "https://manhwanex.com";

describe("parseSeriesMetadata (manhwanex)", () => {
  it("extracts the title from .post-title h1", () => {
    expect(parseSeriesMetadata(fixture("series.html")).title).toBe("SSS Grade Saint Knight");
  });
  it("extracts the cover from .summary_image img", () => {
    expect(parseSeriesMetadata(fixture("series.html")).coverUrl).toBe(
      "https://manhwanex.com/wp-content/uploads/2026/03/SSS-Grade-Saint-Knight-Manhua-Cover.webp",
    );
  });
  it("throws ManhwanexParseError when the title is absent", () => {
    expect(() => parseSeriesMetadata("<html><body></body></html>")).toThrow(ManhwanexParseError);
  });
});

describe("parseChapterList (manhwanex, from the ajax/chapters fragment)", () => {
  it("parses all 33 chapters with absolute urls and numeric numbers", () => {
    const chapters = parseChapterList(fixture("chapters-ajax.html"), ORIGIN);
    expect(chapters.length).toBe(33);
    for (const c of chapters) {
      expect(c.url).toMatch(/^https:\/\/manhwanex\.com\/manga\/sss-grade-saint-knight\/chapter-[\d.]+\/?$/);
      expect(Number.isNaN(c.number)).toBe(false);
    }
  });
  it("returns unique chapter numbers", () => {
    const nums = parseChapterList(fixture("chapters-ajax.html"), ORIGIN).map((c) => c.number);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe("parseReaderImages (manhwanex)", () => {
  it("extracts all 7 reader images from .reading-content, trimming whitespace", () => {
    const imgs = parseReaderImages(fixture("chapter.html"));
    expect(imgs.length).toBe(7);
    for (const u of imgs) {
      expect(u).toMatch(/^https?:\/\//); // leading space in src must be trimmed off
      expect(u).toBe(u.trim());
    }
  });
});

describe("extractChapterNumber (manhwanex)", () => {
  it("parses 'Chapter 12'", () => expect(extractChapterNumber("Chapter 12")).toBe(12));
  it("parses decimals", () => expect(extractChapterNumber("Chapter 2.5")).toBe(2.5));
});
