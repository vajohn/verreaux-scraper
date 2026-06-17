import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { indexDoneZips } from "../../src/pi/zipIndex.js";
import { formatChapterFolder } from "../../src/packaging/sanitize.js";

function writeZip(doneDir: string, runId: string, sourceUrl: string, orders: number[]): void {
  mkdirSync(join(doneDir, runId), { recursive: true });
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl, seriesTitle: "S", adapter: "a",
    chapterRange: { from: orders[0] ?? 0, to: "latest" }, generatedAt: "t",
  })));
  for (const o of orders) zip.addFile(`S/${formatChapterFolder(o)}/001.webp`, Buffer.from("img"));
  zip.writeZip(join(doneDir, runId, "MySeries.zip"));
}

describe("indexDoneZips", () => {
  let doneDir: string;
  beforeEach(() => { doneDir = mkdtempSync(join(tmpdir(), "done-")); });

  it("indexes orders per sourceUrl, newest run first", async () => {
    writeZip(doneDir, "20260101-000000-aaaa", "https://x/s", [49, 50, 51]);
    writeZip(doneDir, "20260102-000000-bbbb", "https://x/s", [49, 50, 51, 52]);
    const older = new Date(1_700_000_000_000);
    const newer = new Date(1_700_000_002_000);
    utimesSync(join(doneDir, "20260101-000000-aaaa", "MySeries.zip"), older, older);
    utimesSync(join(doneDir, "20260102-000000-bbbb", "MySeries.zip"), newer, newer);
    const index = await indexDoneZips(doneDir);
    const entries = index.get("https://x/s")!;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.runId).toBe("20260102-000000-bbbb"); // newest first
    expect([...entries[0]!.orders].sort((a, b) => a - b)).toEqual([49, 50, 51, 52]);
  });

  it("ignores run dirs without a ZIP and returns an empty map for none", async () => {
    mkdirSync(join(doneDir, "20260101-000000-cccc"), { recursive: true }); // no zip
    const index = await indexDoneZips(doneDir);
    expect(index.size).toBe(0);
  });

  it("skips a ZIP with a manifest but no chapter entries", async () => {
    const runId = "20260103-000000-dddd";
    mkdirSync(join(doneDir, runId), { recursive: true });
    const zip = new AdmZip();
    zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
      schema: 1, sourceUrl: "https://x/empty", seriesTitle: "S", adapter: "a",
      chapterRange: { from: 0, to: "latest" }, generatedAt: "t",
    })));
    zip.addFile("S/cover.webp", Buffer.from("cov"));
    zip.writeZip(join(doneDir, runId, "Empty.zip"));
    const index = await indexDoneZips(doneDir);
    expect(index.has("https://x/empty")).toBe(false);
  });
});
