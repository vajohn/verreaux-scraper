import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";

describe("upsertPositionMerged – isNewSeries", () => {
  it("returns isNewSeries=true on the first upsert for a sourceUrl, false on subsequent calls", async () => {
    const s = new InMemoryAccountStore();
    const acc = await s.createAccount("tester", "hash");
    await s.addDevice(acc.id, {
      id: "d1",
      name: "Device 1",
      tokenHash: "th-1",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    const first = await s.upsertPositionMerged(acc.id, "https://x/s", {
      chapterOrder: 1,
      pageIndex: 0,
      manuallyMarked: false,
      device: "d1",
    });
    expect(first.isNewSeries).toBe(true);

    const second = await s.upsertPositionMerged(acc.id, "https://x/s", {
      chapterOrder: 1,
      pageIndex: 1,
      manuallyMarked: false,
      device: "d1",
    });
    expect(second.isNewSeries).toBe(false);
  });
});
