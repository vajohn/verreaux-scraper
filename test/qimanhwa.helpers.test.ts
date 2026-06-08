import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractNgState,
  findCachedBodyByUrlSuffix,
  mapSeriesMeta,
  mapChapterList,
  mapChapterImages,
  QimanhwaParseError,
} from "../src/adapters/qimanhwa.helpers.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/qimanhwa", name), "utf8");
}

describe("extractNgState (qimanhwa)", () => {
  it("parses the ng-state JSON blob", () => {
    const state = extractNgState(fixture("series.html"));
    expect(state).not.toBeNull();
    expect(typeof state).toBe("object");
  });
  it("returns null when no ng-state script is present", () => {
    expect(extractNgState("<html><body>nope</body></html>")).toBeNull();
  });
});

describe("findCachedBodyByUrlSuffix (qimanhwa)", () => {
  it("finds the chapters-list cached body on the series page", () => {
    const state = extractNgState(fixture("series.html"))!;
    const body = findCachedBodyByUrlSuffix(state, "/series/office-worker-who-sees-fate/chapters") as any;
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe("mapSeriesMeta (qimanhwa)", () => {
  it("extracts title and cover from the series page ng-state", () => {
    const state = extractNgState(fixture("series.html"))!;
    const meta = mapSeriesMeta(state, "office-worker-who-sees-fate");
    expect(meta.title).toBe("Office Worker Who Sees Fate");
    expect(meta.coverUrl).toMatch(/^https?:\/\//);
  });
});

describe("mapChapterList (qimanhwa)", () => {
  it("maps free chapters to ascending RawQiChapter, skipping paid ones", () => {
    const state = extractNgState(fixture("series.html"))!;
    const { chapters, skippedLocked } = mapChapterList(state, "office-worker-who-sees-fate");
    expect(chapters.length).toBe(27);
    expect(skippedLocked).toBe(3);
    const nums = chapters.map((c) => c.number);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));
    for (const c of chapters) {
      expect(c.slug).toMatch(/^chapter-/);
      expect(c.url).toBe(`https://qimanhwa.com/series/office-worker-who-sees-fate/${c.slug}`);
    }
  });
});

describe("mapChapterImages (qimanhwa)", () => {
  it("extracts the chapter image urls in order from the chapter page ng-state", () => {
    const state = extractNgState(fixture("chapter.html"))!;
    const images = mapChapterImages(state, "office-worker-who-sees-fate", "chapter-0");
    expect(images.length).toBe(55);
    for (const u of images) expect(u).toMatch(/^https?:\/\//);
  });
  it("throws QimanhwaParseError when the chapter body is missing", () => {
    const state = extractNgState(fixture("series.html"))!; // series page has no chapter-0 body
    expect(() => mapChapterImages(state, "office-worker-who-sees-fate", "chapter-0")).toThrow(QimanhwaParseError);
  });
});
