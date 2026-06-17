import type { CachedZip } from "./zipIndex.js";

export interface ScrapeSegment {
  from: number;
  to: number | "latest";
}

export interface CacheReusePlan {
  cachedZip: CachedZip;
  /** Cached orders (>= from) to copy into the assembled output. */
  reuseOrders: number[];
  /** Disjoint ranges to scrape fresh: integer gaps within the cached span,
   *  then the tail above it (`to: "latest"`). */
  scrapeSegments: ScrapeSegment[];
}

/**
 * From the candidate cached ZIPs (newest-first), pick the first that has any
 * order >= `from`. Reuse all its in-range orders; scrape the integer gaps
 * between `from` and the highest cached order, plus the tail above it. Returns
 * null when no candidate has anything reusable (caller scrapes the original
 * range). `from` is always an integer here (parseFromArg only matches `\d+`).
 */
export function planCacheReuse(from: number, candidates: CachedZip[]): CacheReusePlan | null {
  for (const cachedZip of candidates) {
    const inRange = [...cachedZip.orders].filter((o) => o >= from).sort((a, b) => a - b);
    if (inRange.length === 0) continue;
    const floorE = Math.floor(inRange[inRange.length - 1]!);
    const present = new Set(inRange);
    const segments: ScrapeSegment[] = [];

    // Integer gaps within [from .. floorE] — includes the lower gap
    // [from .. firstCached-1] when the cached block floats above `from`.
    let gapStart: number | null = null;
    for (let k = from; k <= floorE; k++) {
      // fractional cached orders (e.g. 50.5) never match an integer k — intentional: the integer slot is then scraped while the fractional order stays in reuseOrders.
      const missing = !present.has(k);
      if (missing && gapStart === null) gapStart = k;
      if (!missing && gapStart !== null) {
        segments.push({ from: gapStart, to: k - 1 });
        gapStart = null;
      }
    }
    if (gapStart !== null) segments.push({ from: gapStart, to: floorE });

    // Tail above the cached block — always scraped to catch newer chapters.
    segments.push({ from: floorE + 1, to: "latest" });

    return { cachedZip, reuseOrders: inRange, scrapeSegments: segments };
  }
  return null;
}
