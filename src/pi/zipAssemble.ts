import { rename } from "node:fs/promises";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const AdmZip = _require("adm-zip") as typeof import("adm-zip");

export interface AssembleOpts {
  cachedZipPath: string;
  seriesFolder: string;
  /** Chapter orders (may include fractional values such as 50.5) to copy from the cached ZIP. */
  reuseOrders: number[];
  /** ISO timestamp for the recomputed manifest; defaults to assembly time. */
  generatedAt?: string;
  /** Zero or more delta scrape outputs (disjoint ranges). Delta wins on overlap. */
  deltaZipPaths: string[];
  /** Output path WITHOUT the `.zip` extension. */
  outPath: string;
  /** Original requested `from`, recorded in the recomputed manifest. */
  from: number;
}

const CHAPTER_RE = /^(.+?)\/(chapter[^/]*)\//i;

function orderOf(chapterFolder: string): number {
  const m = chapterFolder.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  return m[2] !== undefined ? parseFloat(`${m[1]}.${m[2]}`) : parseInt(m[1]!, 10);
}

/**
 * Build `<outPath>.zip` from the reused cached chapters + every delta chapter,
 * with a recomputed root verreaux.json (`from` original, `to` = highest order
 * present). Delta entries win on overlap. Atomic via .tmp + rename.
 */
export async function assembleOutputZip(opts: AssembleOpts): Promise<void> {
  const out = new AdmZip();
  const seenChapters = new Set<string>();
  let maxOrder = opts.from;
  let manifestTemplate: Record<string, unknown> | null = null;

  // Deltas first so their chapters take precedence on any overlap. The deltas
  // are disjoint ranges, so order among them does not matter.
  for (const deltaPath of opts.deltaZipPaths) {
    const delta = new AdmZip(deltaPath);
    for (const e of delta.getEntries()) {
      if (e.entryName === "verreaux.json") {
        if (!manifestTemplate) manifestTemplate = JSON.parse(e.getData().toString("utf8")) as Record<string, unknown>;
        continue;
      }
      const m = e.entryName.match(CHAPTER_RE);
      if (m) {
        seenChapters.add(m[2]!.toLowerCase());
        maxOrder = Math.max(maxOrder, orderOf(m[2]!));
      }
      if (!out.getEntry(e.entryName)) out.addFile(e.entryName, e.getData());
    }
  }

  // Reused cached chapters: only the planned orders, only folders no delta gave.
  const reuse = new Set(opts.reuseOrders);
  const cached = new AdmZip(opts.cachedZipPath);
  for (const e of cached.getEntries()) {
    if (e.entryName === "verreaux.json") {
      if (!manifestTemplate) manifestTemplate = JSON.parse(e.getData().toString("utf8")) as Record<string, unknown>;
      continue;
    }
    const m = e.entryName.match(CHAPTER_RE);
    if (m) {
      const folder = m[2]!;
      if (seenChapters.has(folder.toLowerCase())) continue;  // a delta already provided it
      if (!reuse.has(orderOf(folder))) continue;              // not in the reuse plan
      maxOrder = Math.max(maxOrder, orderOf(folder));
      if (!out.getEntry(e.entryName)) out.addFile(e.entryName, e.getData());
      continue;
    }
    // Non-chapter entry (e.g. cover) — carry only if no delta already added one.
    if (!out.getEntry(e.entryName)) out.addFile(e.entryName, e.getData());
  }

  const manifest = {
    schema: 1,
    sourceUrl: (manifestTemplate?.["sourceUrl"] as string) ?? "",
    seriesTitle: (manifestTemplate?.["seriesTitle"] as string) ?? opts.seriesFolder,
    adapter: (manifestTemplate?.["adapter"] as string) ?? "",
    chapterRange: { from: opts.from, to: maxOrder },
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  };
  if (out.getEntry("verreaux.json")) out.deleteFile("verreaux.json");
  out.addFile("verreaux.json", Buffer.from(JSON.stringify(manifest, null, 2)));

  const tmp = `${opts.outPath}.zip.tmp`;
  out.writeZip(tmp);
  await rename(tmp, `${opts.outPath}.zip`);
}
