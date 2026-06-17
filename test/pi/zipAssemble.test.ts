import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { formatChapterFolder } from "../../src/packaging/sanitize.js";
import { assembleOutputZip } from "../../src/pi/zipAssemble.js";

function makeZip(path: string, folder: string, orders: number[], withCover = false): void {
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl: "https://x/s", seriesTitle: folder, adapter: "a",
    chapterRange: { from: orders[0] ?? 0, to: "latest" }, generatedAt: "t",
  })));
  if (withCover) zip.addFile(`${folder}/cover.webp`, Buffer.from("cov"));
  for (const o of orders) zip.addFile(`${folder}/${formatChapterFolder(o)}/001.webp`, Buffer.from(`p${o}`));
  zip.writeZip(path);
}

/** Sorted chapter orders present in a ZIP (parsed from each chapter folder name). */
function ordersOf(zipPath: string): number[] {
  const set = new Set<number>();
  for (const e of new AdmZip(zipPath).getEntries()) {
    const parts = e.entryName.split("/");
    if (parts.length < 2) continue;            // root verreaux.json
    const m = parts[1]!.match(/(\d+)(?:\.(\d+))?/);
    if (!m) continue;                          // cover.webp (no digits)
    set.add(m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10));
  }
  return [...set].sort((a, b) => a - b);
}

describe("assembleOutputZip", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "asm-")); });

  it("merges reused cached chapters + multiple delta ZIPs with a recomputed manifest", async () => {
    const cached = join(dir, "cached.zip");
    const d1 = join(dir, "d1.zip");
    const d2 = join(dir, "d2.zip");
    makeZip(cached, "S", [55, 56, 57, 58], true); // floating cached chunk
    makeZip(d1, "S", [49, 50, 51, 52, 53, 54]);    // lower-gap delta
    makeZip(d2, "S", [59, 60]);                     // tail delta
    const outPath = join(dir, "output");

    await assembleOutputZip({
      cachedZipPath: cached, seriesFolder: "S", reuseOrders: [55, 56, 57, 58],
      deltaZipPaths: [d1, d2], outPath, from: 49,
    });

    expect(ordersOf(`${outPath}.zip`)).toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    const manifest = JSON.parse(new AdmZip(`${outPath}.zip`).getEntry("verreaux.json")!.getData().toString("utf8"));
    expect(manifest.chapterRange).toEqual({ from: 49, to: 60 });
    expect(new AdmZip(`${outPath}.zip`).getEntry("S/cover.webp")).toBeTruthy(); // carried from cached
  });

  it("works with no deltas (cached window alone)", async () => {
    const cached = join(dir, "cached.zip");
    makeZip(cached, "S", [49, 50], true);
    const outPath = join(dir, "output");
    await assembleOutputZip({
      cachedZipPath: cached, seriesFolder: "S", reuseOrders: [49, 50],
      deltaZipPaths: [], outPath, from: 49,
    });
    const manifest = JSON.parse(new AdmZip(`${outPath}.zip`).getEntry("verreaux.json")!.getData().toString("utf8"));
    expect(manifest.chapterRange).toEqual({ from: 49, to: 50 });
    expect(ordersOf(`${outPath}.zip`)).toEqual([49, 50]);
  });

  it("delta wins over cached for an overlapping chapter", async () => {
    const cached = join(dir, "cached.zip");
    const delta = join(dir, "delta.zip");
    const cz = new AdmZip();
    cz.addFile("verreaux.json", Buffer.from(JSON.stringify({ schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a", chapterRange: { from: 50, to: "latest" }, generatedAt: "t" })));
    cz.addFile(`S/${formatChapterFolder(50)}/001.webp`, Buffer.from("CACHED"));
    cz.writeZip(cached);
    const dz = new AdmZip();
    dz.addFile("verreaux.json", Buffer.from(JSON.stringify({ schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a", chapterRange: { from: 50, to: "latest" }, generatedAt: "t" })));
    dz.addFile(`S/${formatChapterFolder(50)}/001.webp`, Buffer.from("DELTA"));
    dz.writeZip(delta);
    const outPath = join(dir, "output");
    await assembleOutputZip({ cachedZipPath: cached, seriesFolder: "S", reuseOrders: [50], deltaZipPaths: [delta], outPath, from: 50 });
    const entry = new AdmZip(`${outPath}.zip`).getEntry(`S/${formatChapterFolder(50)}/001.webp`)!;
    expect(entry.getData().toString()).toBe("DELTA");
  });

  it("reuses a fractional cached chapter (50.5)", async () => {
    const cached = join(dir, "cached.zip");
    makeZip(cached, "S", [50, 50.5, 51], false);
    const outPath = join(dir, "output");
    await assembleOutputZip({ cachedZipPath: cached, seriesFolder: "S", reuseOrders: [50, 50.5, 51], deltaZipPaths: [], outPath, from: 50 });
    expect(ordersOf(`${outPath}.zip`)).toEqual([50, 50.5, 51]);
  });

  it("delta cover wins over cached cover", async () => {
    const cached = join(dir, "cached.zip");
    const delta = join(dir, "delta.zip");
    const cz = new AdmZip();
    cz.addFile("verreaux.json", Buffer.from(JSON.stringify({ schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a", chapterRange: { from: 49, to: "latest" }, generatedAt: "t" })));
    cz.addFile("S/cover.webp", Buffer.from("CACHEDCOVER"));
    cz.addFile(`S/${formatChapterFolder(49)}/001.webp`, Buffer.from("p49"));
    cz.writeZip(cached);
    const dz = new AdmZip();
    dz.addFile("verreaux.json", Buffer.from(JSON.stringify({ schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a", chapterRange: { from: 50, to: "latest" }, generatedAt: "t" })));
    dz.addFile("S/cover.webp", Buffer.from("DELTACOVER"));
    dz.addFile(`S/${formatChapterFolder(50)}/001.webp`, Buffer.from("p50"));
    dz.writeZip(delta);
    const outPath = join(dir, "output");
    await assembleOutputZip({ cachedZipPath: cached, seriesFolder: "S", reuseOrders: [49], deltaZipPaths: [delta], outPath, from: 49 });
    const cover = new AdmZip(`${outPath}.zip`).getEntry("S/cover.webp")!;
    expect(cover.getData().toString()).toBe("DELTACOVER");
  });
});
