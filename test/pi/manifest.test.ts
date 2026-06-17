import { describe, it, expect } from "vitest";
import { buildManifest } from "../../src/pi/manifest.js";

describe("buildManifest", () => {
  it("captures source url, title, adapter and range", () => {
    const m = buildManifest({
      sourceUrl: "https://qimanhwa.com/series/x",
      seriesTitle: "Series X",
      adapter: "qimanhwa",
      from: 1,
      to: 42,
      generatedAt: "2026-06-16T15:30:12Z",
    });
    expect(m).toEqual({
      schema: 1,
      sourceUrl: "https://qimanhwa.com/series/x",
      seriesTitle: "Series X",
      adapter: "qimanhwa",
      chapterRange: { from: 1, to: 42 },
      generatedAt: "2026-06-16T15:30:12Z",
    });
  });

  it("serializes 'latest' as the string upper bound", () => {
    const m = buildManifest({
      sourceUrl: "https://x.test/s",
      seriesTitle: "S",
      adapter: "a",
      from: 0,
      to: "latest",
      generatedAt: "t",
    });
    expect(m.chapterRange.to).toBe("latest");
  });
});
