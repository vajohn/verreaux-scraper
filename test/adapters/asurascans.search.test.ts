import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseAsuraSearch } from "../../src/adapters/asurascans.helpers.js";

const body = readFileSync(
  new URL("../fixtures/search/asurascans.json", import.meta.url),
  "utf-8",
);

describe("parseAsuraSearch", () => {
  it("builds /series/<slug> URLs tagged asurascans", () => {
    const out = parseAsuraSearch(body);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].adapterId).toBe("asurascans");
    expect(out[0].seriesUrl).toMatch(/^https:\/\/asurascans\.com\/series\//);
    expect(out[0].title.length).toBeGreaterThan(0);
  });
});
