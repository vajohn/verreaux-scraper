export interface RunDirStat {
  name: string;
  /** Last-modified time of the run dir, ms since epoch (≈ completion time). */
  mtimeMs: number;
}

/**
 * Names of completed run dirs whose age exceeds the TTL, so the worker can prune
 * them. Output ZIPs are large, so done/<id>/ is kept only long enough for a
 * device to download/sync it (default 1 day) — see ai/future-ideas.md.
 */
export function expiredRunDirs(entries: RunDirStat[], nowMs: number, ttlMs: number): string[] {
  return entries.filter((e) => nowMs - e.mtimeMs > ttlMs).map((e) => e.name);
}
