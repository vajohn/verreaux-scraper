import { describe, it, expect } from "vitest";
import { listAdapters } from "../../src/pi/searchService.js";
import { adapterRegistry } from "../../src/adapters/index.js";
describe("listAdapters", () => {
  it("reports id, name, host, and searchable for every adapter", () => {
    const list = listAdapters(adapterRegistry);
    expect(list.length).toBe(7);
    const asura = list.find((a) => a.id === "asurascans")!;
    expect(asura.searchable).toBe(true);
    expect(asura.name).toBe("Asura Scans");
    expect(typeof asura.host).toBe("string");
    expect(asura.host.length).toBeGreaterThan(0);
    expect(list.every((a) => typeof a.searchable === "boolean")).toBe(true);
    // the 5 implemented searchers are searchable
    const searchable = list.filter((a) => a.searchable).map((a) => a.id).sort();
    expect(searchable).toEqual(["arenascan","asurascans","hivetoons","manhuaplus","qimanhwa"]);
  });
});
