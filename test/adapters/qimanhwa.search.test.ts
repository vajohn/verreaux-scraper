import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseQimangaSearch } from "../../src/adapters/qimanhwa.helpers.js";
import { qimanhwaAdapter } from "../../src/adapters/qimanhwa.js";

const body = readFileSync(
  new URL("../fixtures/search/qimanhwa.json", import.meta.url),
  "utf-8",
);

describe("qimanhwa search", () => {
  it("matches the rebranded host qimanga.com", () => {
    expect(qimanhwaAdapter.matchHost("qimanga.com")).toBe(true);
    expect(qimanhwaAdapter.matchHost("qimanhwa.com")).toBe(true); // keep old
  });

  it("parses qimanga results tagged qimanhwa", () => {
    const out = parseQimangaSearch(body);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].adapterId).toBe("qimanhwa");
    expect(out[0].title.length).toBeGreaterThan(0);
    expect(out[0].seriesUrl).toMatch(/^https:\/\/qimanga\.com\//);
  });
});
