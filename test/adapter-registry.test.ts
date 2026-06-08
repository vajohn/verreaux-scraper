import { describe, it, expect } from "vitest";
import { adapterRegistry } from "../src/adapters/index.js";

describe("adapterRegistry host matching", () => {
  it("routes manhwanex.com to the manhwanex adapter", () => {
    const a = adapterRegistry.matchUrl("https://manhwanex.com/manga/x/");
    expect(a?.id).toBe("manhwanex");
  });

  it("routes qimanhwa.com to the qimanhwa adapter", () => {
    const a = adapterRegistry.matchUrl("https://qimanhwa.com/series/x");
    expect(a?.id).toBe("qimanhwa");
  });
});
