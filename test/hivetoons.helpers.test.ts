import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSeriesPage, parseChapterPage, extractImageArrayFromScript } from "../src/adapters/hivetoons.helpers.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/hivetoons", name), "utf8");
}

const ORIGIN = "https://hivetoons.org";

describe("parseSeriesPage", () => {
  it("extracts title and cover and chapters", () => {
    const html = fixture("series.html");
    const meta = parseSeriesPage(html, ORIGIN);
    expect(meta.title).toBe("Eleceed");
    expect(meta.coverUrl).toBe("https://hivetoons.cdn/eleceed/cover.jpg");
    expect(meta.chapters).toHaveLength(3);
    expect(meta.chapters.map((c) => c.number)).toEqual([2, 1, 0]);
  });
});

describe("parseChapterPage", () => {
  it("extracts image URLs from img tags and srcset", () => {
    const html = fixture("chapter.html");
    const urls = parseChapterPage(html, ORIGIN);
    // should include img data-src, img src, and srcset resolved to largest candidate
    expect(urls).toContain("https://hivetoons.cdn/eleceed/001.jpg");
    expect(urls).toContain("https://hivetoons.cdn/eleceed/002.jpg");
    expect(urls).toContain("https://hivetoons.cdn/eleceed/003.jpg");
  });

  it("falls back to inline script array when no imgs present", () => {
    const html = `\n      <html><body><script>var images = ["https://a/1.jpg","https://a/2.jpg"];</script></body></html>`;
    const urls = parseChapterPage(html, ORIGIN);
    expect(urls).toHaveLength(2);
  });
});

describe("extractImageArrayFromScript", () => {
  it("parses simple var images = [...] arrays", () => {
    const html = fixture("chapter.html");
    const arr = extractImageArrayFromScript(html);
    expect(arr).toHaveLength(2);
    expect(arr[0]).toBe("https://hivetoons.cdn/eleceed/004.jpg");
  });
});

