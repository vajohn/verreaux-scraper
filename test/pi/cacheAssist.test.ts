import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { formatChapterFolder } from "../../src/packaging/sanitize.js";
import { runScrapeWithCache, parseFromArg } from "../../src/pi/cacheAssist.js";

function writeRunZip(doneDir: string, runId: string, orders: number[]): void {
  mkdirSync(join(doneDir, runId), { recursive: true });
  const zip = new AdmZip();
  zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
    schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a",
    chapterRange: { from: orders[0]!, to: "latest" }, generatedAt: "t",
  })));
  for (const o of orders) zip.addFile(`S/${formatChapterFolder(o)}/001.webp`, Buffer.from(`p${o}`));
  zip.writeZip(join(doneDir, runId, "Cached.zip"));
}

/** Sorted chapter orders present in a ZIP (parsed from chapter folder names). */
function ordersOf(zipPath: string): number[] {
  const set = new Set<number>();
  for (const e of new AdmZip(zipPath).getEntries()) {
    const parts = e.entryName.split("/");
    if (parts.length < 2) continue;
    const m = parts[1]!.match(/(\d+)(?:\.(\d+))?/);
    if (!m) continue;
    set.add(m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10));
  }
  return [...set].sort((a, b) => a - b);
}

/** Finds the single *.zip in a directory (mirrors the API's glob) and returns its orders. */
function zipOrdersIn(dir: string): number[] {
  const name = readdirSync(dir).find((n) => n.endsWith(".zip"))!;
  return ordersOf(join(dir, name));
}

/** Fake scrape: emit chapters for the requested [--from .. --to] range. `latest`
 *  is treated as LATEST. Empty range -> no zip, non-zero exit (like ERR_EMPTY_RANGE). */
function fakeScrape(LATEST: number, calls: string[][]) {
  return async (extraArgs: string[], dir: string): Promise<number> => {
    calls.push(extraArgs);
    const fi = extraArgs.indexOf("--from");
    const ti = extraArgs.indexOf("--to");
    const from = parseInt(extraArgs[fi + 1]!, 10);
    const toRaw = extraArgs[ti + 1]!;
    const to = toRaw === "latest" ? LATEST : parseInt(toRaw, 10);
    if (from > to) return 1; // empty range
    const zip = new AdmZip();
    zip.addFile("verreaux.json", Buffer.from(JSON.stringify({
      schema: 1, sourceUrl: "https://x/s", seriesTitle: "S", adapter: "a",
      chapterRange: { from, to: toRaw === "latest" ? "latest" : to }, generatedAt: "t",
    })));
    for (let o = from; o <= to; o++) zip.addFile(`S/${formatChapterFolder(o)}/001.webp`, Buffer.from(`p${o}`));
    zip.writeZip(join(dir, "Delta.zip"));
    return 0;
  };
}

describe("runScrapeWithCache", () => {
  let doneDir: string;
  beforeEach(() => { doneDir = mkdtempSync(join(tmpdir(), "ca-")); });

  it("parseFromArg reads the integer --from", () => {
    expect(parseFromArg("--from 49 --to latest")).toBe(49);
    expect(parseFromArg("--to latest")).toBeNull();
  });

  it("floating cached chunk: scrapes lower gap + tail, reuses the chunk (case 2)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [55, 56, 57, 58]);
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(60, calls),
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([
      ["--from", "49", "--to", "54"],
      ["--from", "59", "--to", "latest"],
    ]);
    expect(zipOrdersIn(outDir)).toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  });

  it("contiguous cache, no newer chapters: empty tail -> serve cached window alone (case 3)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [49, 50, 51]);
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(51, calls), // LATEST=51 so tail 52..51 is empty
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([["--from", "52", "--to", "latest"]]);
    expect(zipOrdersIn(outDir)).toEqual([49, 50, 51]);
  });

  it("no integer --from: single plain scrape into outDir, ignores the cache", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [49, 50]); // present but must be ignored
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: Array<{ args: string[]; dir: string }> = [];
    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--to latest" },
      outDir, doneDir,
      scrape: async (args, dir) => { calls.push({ args, dir }); new AdmZip().writeZip(join(dir, "Plain.zip")); return 0; },
    });
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["--to", "latest"]);
    expect(calls[0]!.dir).toBe(outDir);
  });

  it("logs and skips a segment that produces no chapters (empty tail)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [49, 50, 51]);
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const logs: string[] = [];
    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(51, []), onLog: (m) => logs.push(m),
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => /no chapters|skip/i.test(l))).toBe(true);
  });

  it("cache wholly below `from`: plain scrape of the original range, no assembly (case 1)", async () => {
    writeRunZip(doneDir, "20260101-000000-aaaa", [20, 30]);
    const outDir = join(doneDir, "20260102-000000-bbbb");
    mkdirSync(outDir, { recursive: true });
    const calls: string[][] = [];

    const exit = await runScrapeWithCache({
      job: { id: "20260102-000000-bbbb", type: "scrape", url: "https://x/s", args: "--from 49 --to latest" },
      outDir, doneDir, scrape: fakeScrape(52, calls),
    });

    expect(exit).toBe(0);
    expect(calls).toEqual([["--from", "49", "--to", "latest"]]);
    expect(zipOrdersIn(outDir)).toEqual([49, 50, 51, 52]);
  });
});
