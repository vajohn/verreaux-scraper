import { describe, it, expect } from "vitest";
import { mergePosition, type StoredPosition } from "../../src/pi/positionMerge.js";

const pos = (chapterOrder: number, pageIndex: number, ownerDevice = "d1", manuallyMarked = false): StoredPosition =>
  ({ chapterOrder, pageIndex, ownerDevice, manuallyMarked });

describe("mergePosition", () => {
  it("adopts incoming when there is no current", () => {
    const r = mergePosition(null, { chapterOrder: 12, pageIndex: 3, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ chapterOrder: 12, pageIndex: 3, ownerDevice: "d2", manuallyMarked: false });
  });

  it("keeps the further position when a behind, non-owner device syncs (device-1 p1 vs device-2 p21)", () => {
    const current = pos(12, 21, "d2");
    const r = mergePosition(current, { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d1" });
    expect(r.changed).toBe(false);
    expect(r.value).toEqual(current);
  });

  it("accepts a regression from the owning device (device-2 goes back to p1)", () => {
    const current = pos(12, 21, "d2");
    const r = mergePosition(current, { chapterOrder: 12, pageIndex: 1, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ chapterOrder: 12, pageIndex: 1, ownerDevice: "d2", manuallyMarked: false });
  });

  it("adopts a further position from either device (p25 wins)", () => {
    expect(mergePosition(pos(12, 21, "d2"), { chapterOrder: 12, pageIndex: 25, manuallyMarked: false, device: "d1" }).value)
      .toEqual({ chapterOrder: 12, pageIndex: 25, ownerDevice: "d1", manuallyMarked: false });
  });

  it("orders by chapter first, then page", () => {
    expect(mergePosition(pos(12, 99, "d2"), { chapterOrder: 13, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(true);
    expect(mergePosition(pos(12, 99, "d2"), { chapterOrder: 11, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(false);
  });

  it("handles fractional chapter orders", () => {
    expect(mergePosition(pos(12, 1, "d2"), { chapterOrder: 12.5, pageIndex: 1, manuallyMarked: false, device: "d1" }).changed).toBe(true);
  });

  it("accepts an owner regression across a chapter boundary (ch13 -> ch12)", () => {
    const current = pos(13, 2, "d2");
    const r = mergePosition(current, { chapterOrder: 12, pageIndex: 40, manuallyMarked: false, device: "d2" });
    expect(r.changed).toBe(true);
    expect(r.value).toEqual({ chapterOrder: 12, pageIndex: 40, ownerDevice: "d2", manuallyMarked: false });
  });

  it("treats an equal position as no change", () => {
    expect(mergePosition(pos(12, 5, "d2"), { chapterOrder: 12, pageIndex: 5, manuallyMarked: false, device: "d1" }).changed).toBe(false);
  });

  it("carries manuallyMarked with an adopted value", () => {
    expect(mergePosition(pos(1, 0, "d2"), { chapterOrder: 5, pageIndex: 0, manuallyMarked: true, device: "d1" }).value.manuallyMarked).toBe(true);
  });
});
