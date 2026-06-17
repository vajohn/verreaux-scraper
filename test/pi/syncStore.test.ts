import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";

describe("InMemoryAccountStore", () => {
  it("creates an account, adds a device, and resolves it by token hash", async () => {
    const s = new InMemoryAccountStore();
    const acc = await s.createAccount("johnny", "pass-hash");
    expect(await s.findAccountByUsername("johnny")).toMatchObject({ id: acc.id, username: "johnny" });
    await s.addDevice(acc.id, { id: "dev-1", name: "iPad", tokenHash: "th-1", createdAt: "t", lastSeenAt: "t" });
    const found = await s.findByDeviceTokenHash("th-1");
    expect(found?.account.id).toBe(acc.id);
    expect(found?.device.id).toBe("dev-1");
    expect(await s.findByDeviceTokenHash("nope")).toBeNull();
  });

  it("merges a position via mergePosition and persists the winner", async () => {
    const s = new InMemoryAccountStore();
    const acc = await s.createAccount("u", "h");
    let r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 21, manuallyMarked: false, device: "d2" });
    expect(r.value.pageIndex).toBe(21);
    r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d1" });
    expect(r.changed).toBe(false);
    expect(r.value.pageIndex).toBe(21);
    r = await s.upsertPositionMerged(acc.id, "https://x/s", { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true); // owner regression persists
    expect(r.value.pageIndex).toBe(1);
  });

  it("returns all positions when since is null", async () => {
    const s = new InMemoryAccountStore(() => "2026-06-17T00:00:00Z");
    const acc = await s.createAccount("u", "h");
    await s.upsertPositionMerged(acc.id, "https://x/a", { chapterOrder: 1, pageIndex: 0, manuallyMarked: false, device: "d1" });
    const all = await s.getPositionsSince(acc.id, null);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sourceUrl: "https://x/a", chapterOrder: 1, pageIndex: 0 });
  });

  it("filters to positions strictly newer than 'since'", async () => {
    let clock = "2026-06-17T00:00:00.000Z";
    const s = new InMemoryAccountStore(() => clock);
    const acc = await s.createAccount("u", "h");
    clock = "2026-06-17T00:00:01.000Z";
    await s.upsertPositionMerged(acc.id, "https://x/a", { chapterOrder: 1, pageIndex: 0, manuallyMarked: false, device: "d1" });
    clock = "2026-06-17T00:00:03.000Z";
    await s.upsertPositionMerged(acc.id, "https://x/b", { chapterOrder: 1, pageIndex: 0, manuallyMarked: false, device: "d1" });
    const since = await s.getPositionsSince(acc.id, "2026-06-17T00:00:02.000Z");
    expect(since.map((r) => r.sourceUrl)).toEqual(["https://x/b"]);
  });
});
