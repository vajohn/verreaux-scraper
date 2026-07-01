import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseThemesiaSearch } from "../../src/adapters/arenascan.helpers.js";
const body = readFileSync(new URL("../fixtures/search/arenascan.json", import.meta.url), "utf-8");
describe("parseThemesiaSearch", () => {
  it("maps Themesia results to SeriesSearchResult", () => {
    const out = parseThemesiaSearch("arenascan", body);
    expect(out.length).toBeGreaterThan(0);
    const r = out[0];
    expect(r.adapterId).toBe("arenascan");
    expect(typeof r.title).toBe("string");
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.seriesUrl).toMatch(/^https?:\/\//);
  });
});
