import { describe, it, expect } from "vitest";
import { expiredRunDirs } from "../../src/pi/retention.js";

const DAY = 86_400_000;

describe("expiredRunDirs", () => {
  it("returns dirs older than the TTL, keeps recent ones", () => {
    const now = 10 * DAY;
    const out = expiredRunDirs(
      [
        { name: "old", mtimeMs: now - DAY - 1 }, // > 1 day -> expired
        { name: "fresh", mtimeMs: now - 1000 }, // recent -> kept
        { name: "edge", mtimeMs: now - DAY }, // exactly 1 day -> not strictly older -> kept
      ],
      now,
      DAY,
    );
    expect(out).toEqual(["old"]);
  });

  it("returns nothing when all are within the TTL", () => {
    const now = 5 * DAY;
    expect(expiredRunDirs([{ name: "a", mtimeMs: now - 10 }], now, DAY)).toEqual([]);
  });

  it("returns all when everything is expired", () => {
    const now = 5 * DAY;
    expect(
      expiredRunDirs([{ name: "a", mtimeMs: 0 }, { name: "b", mtimeMs: 100 }], now, DAY),
    ).toEqual(["a", "b"]);
  });
});
