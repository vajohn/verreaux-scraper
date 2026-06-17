import { describe, it, expect } from "vitest";
import { planCacheReuse } from "../../src/pi/cachePlan.js";
import type { CachedZip } from "../../src/pi/zipIndex.js";

function zip(orders: number[], mtimeMs = 1): CachedZip {
  return { runId: "r", zipPath: "/p.zip", seriesFolder: "S", orders: new Set(orders), mtimeMs };
}

describe("planCacheReuse", () => {
  it("contiguous-from-`from`: reuse the block, scrape only the tail", () => {
    const plan = planCacheReuse(49, [zip([49, 50, 51, 52])])!;
    expect(plan.reuseOrders).toEqual([49, 50, 51, 52]);
    expect(plan.scrapeSegments).toEqual([{ from: 53, to: "latest" }]);
  });

  it("floating chunk above `from`: scrape the lower gap, reuse the chunk, scrape the tail", () => {
    const plan = planCacheReuse(49, [zip([55, 56, 57, 58])])!; // case 2
    expect(plan.reuseOrders).toEqual([55, 56, 57, 58]);
    expect(plan.scrapeSegments).toEqual([
      { from: 49, to: 54 },
      { from: 59, to: "latest" },
    ]);
  });

  it("internal hole: scrape just the missing integers plus the tail", () => {
    const plan = planCacheReuse(49, [zip([49, 50, 52])])!; // 51 missing
    expect(plan.reuseOrders).toEqual([49, 50, 52]);
    expect(plan.scrapeSegments).toEqual([
      { from: 51, to: 51 },
      { from: 53, to: "latest" },
    ]);
  });

  it("cache wholly below `from` (or empty): no reuse", () => {
    expect(planCacheReuse(49, [zip([20, 30])])).toBeNull();
    expect(planCacheReuse(49, [])).toBeNull();
  });

  it("skips a candidate with nothing in range and uses the next that has some", () => {
    const plan = planCacheReuse(49, [zip([20, 30]), zip([55, 56])])!;
    expect(plan.reuseOrders).toEqual([55, 56]);
  });

  it("fractional cached orders: integer gaps scraped, fractional orders reused", () => {
    const plan = planCacheReuse(49, [zip([49, 50.5, 51])])!;
    expect(plan.reuseOrders).toEqual([49, 50.5, 51]);
    expect(plan.scrapeSegments).toEqual([
      { from: 50, to: 50 },
      { from: 52, to: "latest" },
    ]);
  });

  it("single cached order at `from`: reuse it, scrape only the tail", () => {
    const plan = planCacheReuse(49, [zip([49])])!;
    expect(plan.reuseOrders).toEqual([49]);
    expect(plan.scrapeSegments).toEqual([{ from: 50, to: "latest" }]);
  });
});
