import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manhwanexAdapter } from "../src/adapters/manhwanex.js";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/manhwanex", name), "utf8");
}

// ctx whose http.get returns the series page and http.post returns the ajax chapter list.
function ctxResolve(): any {
  return {
    http: {
      get: vi.fn().mockResolvedValue({ statusCode: 200, body: fixture("series.html") }),
      post: vi.fn().mockResolvedValue({ statusCode: 200, body: fixture("chapters-ajax.html") }),
    },
    signal: new AbortController().signal,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

describe("ManhwanexAdapter", () => {
  it("matchHost matches manhwanex.com and www.manhwanex.com only", () => {
    expect(manhwanexAdapter.matchHost("manhwanex.com")).toBe(true);
    expect(manhwanexAdapter.matchHost("www.manhwanex.com")).toBe(true);
    expect(manhwanexAdapter.matchHost("example.com")).toBe(false);
  });

  it("id and liveDomain are correct", () => {
    expect(manhwanexAdapter.id).toBe("manhwanex");
    expect(manhwanexAdapter.liveDomain()).toBe("manhwanex.com");
  });

  it("resolveSeries returns title, cover, and 33 ascending chapters from the ajax fragment", async () => {
    const ctx = ctxResolve();
    const res = await manhwanexAdapter.resolveSeries(ctx, "https://manhwanex.com/manga/sss-grade-saint-knight/");
    expect(res.seriesTitle).toBe("SSS Grade Saint Knight");
    expect(res.coverUrl).toContain("SSS-Grade-Saint-Knight");
    // it must POST the ajax/chapters endpoint
    expect(ctx.http.post).toHaveBeenCalled();
    const postUrl = ctx.http.post.mock.calls[0][0];
    expect(postUrl).toBe("https://manhwanex.com/manga/sss-grade-saint-knight/ajax/chapters/");
    const nums = res.preEnumeratedChapters!.map((c: any) => c.chapterNumber);
    expect(nums.length).toBe(33);
    expect([...nums]).toEqual([...nums].sort((a, b) => a - b)); // ascending
  });

  it("parseChapterImages returns 7 ordered PageStubs with the chapter url as referer", async () => {
    const ctx = ctxResolve();
    const stub = { chapterNumber: 143, chapterTitle: null, chapterUrl: "https://manhwanex.com/manga/sss-grade-saint-knight/chapter-143/" };
    const pages = await manhwanexAdapter.parseChapterImages(ctx, stub, fixture("chapter.html"));
    expect(pages.length).toBe(7);
    expect(pages[0]!.pageIndex).toBe(1);
    expect(pages[0]!.referer).toBe(stub.chapterUrl);
    for (const p of pages) expect(p.imageUrl).toMatch(/^https?:\/\//);
  });
});
