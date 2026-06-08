import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qimanhwaAdapter, QimanhwaParseError } from "../src/adapters/qimanhwa.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/qimanhwa", name), "utf8");
}
function ctxRendering(html: string): any {
  return {
    browser: { renderPage: vi.fn().mockResolvedValue(html) },
    signal: new AbortController().signal,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

describe("QimanhwaAdapter", () => {
  it("matchHost matches qimanhwa.com and www. only", () => {
    expect(qimanhwaAdapter.matchHost("qimanhwa.com")).toBe(true);
    expect(qimanhwaAdapter.matchHost("www.qimanhwa.com")).toBe(true);
    expect(qimanhwaAdapter.matchHost("api.qimanhwa.com")).toBe(false);
  });

  it("id and liveDomain are correct", () => {
    expect(qimanhwaAdapter.id).toBe("qimanhwa");
    expect(qimanhwaAdapter.liveDomain()).toBe("qimanhwa.com");
  });

  it("resolveSeries returns title, cover, and ascending free chapters", async () => {
    const ctx = ctxRendering(fixture("series.html"));
    const res = await qimanhwaAdapter.resolveSeries(ctx, "https://qimanhwa.com/series/office-worker-who-sees-fate");
    expect(res.seriesTitle).toBe("Office Worker Who Sees Fate");
    expect(res.coverUrl).toMatch(/^https?:\/\//);
    const nums = res.preEnumeratedChapters!.map((c: any) => c.chapterNumber);
    expect(nums.length).toBe(27);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b));
  });

  it("fetchChapter renders the chapter url and returns its html", async () => {
    const ctx = ctxRendering(fixture("chapter.html"));
    const stub = { chapterNumber: 0, chapterTitle: null, chapterUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate/chapter-0" };
    const resp = await qimanhwaAdapter.fetchChapter!({ ctx, chapter: stub, seriesUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate", signal: ctx.signal });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain("ng-state");
  });

  it("parseChapterImages returns 55 ordered PageStubs with site-origin referer", async () => {
    const ctx = ctxRendering("");
    const stub = { chapterNumber: 0, chapterTitle: null, chapterUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate/chapter-0" };
    const pages = await qimanhwaAdapter.parseChapterImages(ctx, stub, fixture("chapter.html"));
    expect(pages.length).toBe(55);
    expect(pages[0]!.pageIndex).toBe(1);
    expect(pages[0]!.referer).toBe("https://qimanhwa.com/");
  });

  it("parseChapterImages throws QimanhwaParseError when ng-state is absent", async () => {
    const ctx = ctxRendering("");
    const stub = { chapterNumber: 0, chapterTitle: null, chapterUrl: "https://qimanhwa.com/series/office-worker-who-sees-fate/chapter-0" };
    await expect(
      qimanhwaAdapter.parseChapterImages(ctx, stub, "<html>no state here</html>"),
    ).rejects.toThrow(QimanhwaParseError);
  });
});
