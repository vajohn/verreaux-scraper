import { describe, it, expect } from "vitest";
import { adapterRegistry } from "../../src/adapters/index.js";

describe("adapterRegistry.all", () => {
  it("returns every registered adapter with a stable id and displayName", () => {
    const all = adapterRegistry.all();
    expect(all.length).toBe(7);
    const ids = all.map((a) => a.id).sort();
    expect(ids).toEqual([
      "arenascan", "asurascans", "drake", "hivetoons",
      "manhuaplus", "manhwanex", "qimanhwa",
    ]);
    for (const a of all) expect(typeof a.displayName).toBe("string");
  });
});
