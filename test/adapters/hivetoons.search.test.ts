import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseHivetoonsSearch } from "../../src/adapters/hivetoons.helpers.js";
const body = readFileSync(new URL("../fixtures/search/hivetoons.json", import.meta.url), "utf-8");
describe("parseHivetoonsSearch", () => {
  it("maps posts to SeriesSearchResult on the hivetoons host", () => {
    const out = parseHivetoonsSearch(body);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].adapterId).toBe("hivetoons");
    expect(out[0].title.length).toBeGreaterThan(0);
    expect(out[0].seriesUrl).toMatch(/^https:\/\/hivetoons\.org\//);
  });
});
