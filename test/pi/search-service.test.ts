import { describe, it, expect } from "vitest";
import { runSearch } from "../../src/pi/searchService.js";
import type { SourceAdapter, AdapterContext, SeriesSearchResult } from "../../src/core/types.js";

function fakeAdapter(id: string, results: SeriesSearchResult[], throws = false): SourceAdapter {
  return {
    id: id as SourceAdapter["id"], displayName: id,
    matchHost: (h: string) => h.includes(id), domainAliases: () => [`${id}.test`],
    liveDomain: () => `${id}.test`,
    resolveSeries: async () => ({ seriesTitle: "", coverUrl: "", coverReferer: "" }),
    enumerateChapters: async () => [], parseChapterImages: async () => [],
    dismissNsfwSplash: async () => {},
    search: async () => { if (throws) throw new Error("boom"); return results; },
  } as unknown as SourceAdapter;
}
const ctx = {} as AdapterContext;
const good = fakeAdapter("good", [{ adapterId: "good" as SourceAdapter["id"], title: "T", seriesUrl: "https://good.test/series/x", coverUrl: null }]);
const bad = fakeAdapter("bad", [], true);

describe("runSearch", () => {
  it("returns good results and isolates per-adapter failures", async () => {
    const registry = { all: () => [good, bad], byId: (id: string) => (id === "good" ? good : bad), matchUrl: () => null } as any;
    const out = await runSearch(registry, ctx, "q", ["good", "bad"]);
    expect(out.results.map((r) => r.title)).toEqual(["T"]);
    expect(out.errors.find((e) => e.adapterId === "bad")).toBeTruthy();
  });
  it("drops results whose URL host the adapter does not match (anti-spoof)", async () => {
    const spoof = fakeAdapter("good", [{ adapterId: "good" as SourceAdapter["id"], title: "X", seriesUrl: "https://evil.test/x", coverUrl: null }]);
    const registry = { all: () => [spoof], byId: () => spoof, matchUrl: () => null } as any;
    const out = await runSearch(registry, ctx, "q", ["good"]);
    expect(out.results).toEqual([]);
  });
});
