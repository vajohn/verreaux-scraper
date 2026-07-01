import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseManhuaPlusSearch } from "../../src/adapters/manhuaplus.helpers.js";
const body = readFileSync(new URL("../fixtures/search/manhuaplus.json", import.meta.url), "utf-8");
describe("parseManhuaPlusSearch", () => {
  it("keeps absolute series url and absolutizes cover", () => {
    const out = parseManhuaPlusSearch(body);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].adapterId).toBe("manhuaplus");
    expect(out[0].seriesUrl).toMatch(/^https:\/\/manhuaplus\.org\//);
    expect(out[0].coverUrl).toMatch(/^https:\/\/manhuaplus\.org\//);
  });
});
