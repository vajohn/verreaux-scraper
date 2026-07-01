import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseManhwanexSearch } from "../../src/adapters/manhwanex.helpers.js";
const body = readFileSync(new URL("../fixtures/search/manhwanex.json", import.meta.url), "utf-8");
describe("parseManhwanexSearch", () => {
  it("maps Madara wp-manga-search-manga results to SeriesSearchResult", () => {
    const out = parseManhwanexSearch(body);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].adapterId).toBe("manhwanex");
    expect(out[0].title.length).toBeGreaterThan(0);
    expect(out[0].seriesUrl).toMatch(/^https:\/\/manhwanex\.com\//);
  });
});
