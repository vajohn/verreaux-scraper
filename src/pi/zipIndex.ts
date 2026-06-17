import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { VerreauxManifest } from "./manifest.js";

// adm-zip is CommonJS; load via createRequire under NodeNext ESM.
const _require = createRequire(import.meta.url);
const AdmZip = _require("adm-zip") as typeof import("adm-zip");

/** First `*.zip` in a directory (run output ZIPs are named `<series>.zip`, not a
 *  fixed name; `.zip.tmp` files are excluded by the suffix check). Null if none. */
export async function firstZipPath(dir: string): Promise<string | null> {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".zip"));
    return names.length ? join(dir, names[0]!) : null;
  } catch {
    return null;
  }
}

export interface CachedZip {
  runId: string;
  zipPath: string;
  seriesFolder: string;
  orders: Set<number>;
  mtimeMs: number;
}

/** Chapter order from a chapter-folder name (mirrors packager's extractSortKey). */
function orderFromChapterName(name: string): number | null {
  const m = name.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10);
}

/** Index every `done/<run>/output.zip` by its manifest sourceUrl. Each source's
 *  candidate ZIPs are returned newest-first (by run dir mtime). Best-effort:
 *  unreadable or manifest-less ZIPs are skipped. */
export async function indexDoneZips(doneDir: string): Promise<Map<string, CachedZip[]>> {
  const out = new Map<string, CachedZip[]>();
  let runIds: string[];
  try {
    runIds = (await readdir(doneDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const runId of runIds) {
    const zipPath = await firstZipPath(join(doneDir, runId));
    if (!zipPath) continue; // no ZIP yet (running/failed run)
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(zipPath)).mtimeMs;
    } catch {
      continue;
    }
    try {
      const zip = new AdmZip(zipPath);
      const manifestEntry = zip.getEntry("verreaux.json");
      if (!manifestEntry) continue;
      const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as VerreauxManifest;
      if (!manifest.sourceUrl) continue;
      const orders = new Set<number>();
      let seriesFolder = "";
      for (const e of zip.getEntries()) {
        const parts = e.entryName.split("/");
        if (parts.length < 2) continue;
        // Single top-level series folder per ZIP (packager guarantees this); last write wins harmlessly.
        seriesFolder = parts[0]!;
        const ord = orderFromChapterName(parts[1]!);
        if (ord !== null) orders.add(ord);
      }
      if (orders.size === 0) continue;
      const list = out.get(manifest.sourceUrl) ?? [];
      list.push({ runId, zipPath, seriesFolder, orders, mtimeMs });
      out.set(manifest.sourceUrl, list);
    } catch {
      continue;
    }
  }
  for (const list of out.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
