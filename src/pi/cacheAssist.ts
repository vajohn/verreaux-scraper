import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScrapeJob } from "./job.js";
import { indexDoneZips } from "./zipIndex.js";
import { planCacheReuse, type ScrapeSegment } from "./cachePlan.js";
import { assembleOutputZip } from "./zipAssemble.js";

/** Parse `--from N` out of a job's arg string. Null if absent/non-integer. */
export function parseFromArg(args: string): number | null {
  const m = args.match(/--from\s+(\d+)\b/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Rebuild the job's argv for one scrape segment (override --from / --to). */
function segmentArgs(jobArgs: string, seg: ScrapeSegment): string[] {
  let s = jobArgs;
  s = /--from\s+\S+/.test(s) ? s.replace(/--from\s+\S+/, `--from ${seg.from}`) : `${s} --from ${seg.from}`;
  s = /--to\s+\S+/.test(s) ? s.replace(/--to\s+\S+/, `--to ${seg.to}`) : `${s} --to ${seg.to}`;
  return s.trim().split(/\s+/);
}

export interface CacheAssistDeps {
  job: ScrapeJob;
  /** This run's output dir (where the final output.zip must land). */
  outDir: string;
  /** The done/ root, used as the cache. */
  doneDir: string;
  /** Runs the real scrape with the given EXTRA argv, writing output.zip into the
   *  given dir. Resolves with the process exit code. */
  scrape: (extraArgs: string[], outDir: string) => Promise<number>;
  /** Optional sink for best-effort notes (wired to the run log). */
  onLog?: (msg: string) => void;
}

/**
 * Run a scrape, reusing chapters from a recent cached run ZIP when possible.
 * Scrapes one segment (gap or tail) per disjoint range the cache does not
 * cover, then assembles the cached reuse + every produced delta into
 * `outDir/output.zip`. Falls back to a single plain scrape (original args,
 * straight into outDir, no assembly) when nothing is cached, the job has no
 * integer `--from`, or it is a probe.
 *
 * Best-effort on segment failures: a segment that produces no output.zip (e.g.
 * ERR_EMPTY_RANGE on the tail, locked early chapters, or a transient error) is
 * skipped; the run still succeeds with the reuse + whatever deltas landed, and
 * the device re-syncs later to fill any remaining gap.
 */
export async function runScrapeWithCache(deps: CacheAssistDeps): Promise<number> {
  const { job, outDir, doneDir, scrape, onLog } = deps;
  const origExtra = job.args.trim() ? job.args.trim().split(/\s+/) : [];

  const from = job.type === "scrape" ? parseFromArg(job.args) : null;
  if (from === null) return scrape(origExtra, outDir);

  const index = await indexDoneZips(doneDir);
  const plan = planCacheReuse(from, index.get(job.url) ?? []);
  if (!plan) return scrape(origExtra, outDir);

  const segDirs: string[] = [];
  try {
    const deltaZips: string[] = [];
    for (const seg of plan.scrapeSegments) {
      const dir = await mkdtemp(join(tmpdir(), "verreaux-delta-"));
      segDirs.push(dir);
      await scrape(segmentArgs(job.args, seg), dir);
      const z = join(dir, "output.zip");
      if (await stat(z).then(() => true).catch(() => false)) deltaZips.push(z);
      else onLog?.(`cache-assist: segment --from ${seg.from} --to ${seg.to} produced no chapters; skipping`);
    }
    await assembleOutputZip({
      cachedZipPath: plan.cachedZip.zipPath,
      seriesFolder: plan.cachedZip.seriesFolder,
      reuseOrders: plan.reuseOrders,
      deltaZipPaths: deltaZips,
      outPath: join(outDir, "output"),
      from,
    });
    return 0;
  } finally {
    for (const d of segDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
}
