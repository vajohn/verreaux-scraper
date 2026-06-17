import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseJob, type ScrapeJob } from "./job.js";
import { runningStatus, finalStatus, type RunStatus } from "./status.js";

export interface RunnerDirs {
  jobs: string;
  done: string;
  state: string;
}

export interface RunScrapeArgs {
  job: ScrapeJob;
  outDir: string;
  logPath: string;
}

export interface RunnerDeps {
  /** ISO timestamp source (injectable for tests). */
  now: () => string;
  /** Executes the scrape; resolves with the process exit code. */
  runScrape: (args: RunScrapeArgs) => Promise<number>;
}

async function writeStatus(doneDir: string, status: RunStatus): Promise<void> {
  await writeFile(join(doneDir, "status.json"), JSON.stringify(status, null, 2));
}

/**
 * Pull the CLI's failure reason out of a JSON run.log so a failed run carries an
 * actionable message (e.g. "ERR_EMPTY_RANGE: No chapters found in range [0, 1].")
 * instead of a bare exit code. Returns the last `run.fatal` payload message, or
 * null if none is found.
 */
export function extractFailureMessage(log: string): string | null {
  const lines = log.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;
    if (o["event"] !== "run.fatal") continue;
    const payload = o["payload"];
    if (typeof payload !== "object" || payload === null) continue;
    const p = payload as Record<string, unknown>;
    const msg = p["message"];
    if (typeof msg !== "string") continue;
    const code = typeof p["code"] === "string" ? p["code"] : null;
    return code ? `${code}: ${msg}` : msg;
  }
  return null;
}

/**
 * Process a single job file end-to-end. Never throws: any failure is recorded
 * as a `failed` status so the watcher loop keeps running.
 */
export async function processJob(
  jobPath: string,
  dirs: RunnerDirs,
  deps: RunnerDeps,
): Promise<void> {
  const fallbackId = basename(jobPath).replace(/\.json(\.processing)?$/, "");

  let job: ScrapeJob;
  try {
    job = parseJob(await readFile(jobPath, "utf8"));
    if (!job.id) job.id = fallbackId;
  } catch (err) {
    const doneDir = join(dirs.done, fallbackId);
    await mkdir(doneDir, { recursive: true });
    const started = runningStatus(deps.now());
    await writeStatus(
      doneDir,
      finalStatus(started, 2, deps.now(), err instanceof Error ? err.message : String(err)),
    );
    await rename(jobPath, join(dirs.jobs, `${fallbackId}.json.done`)).catch(() => undefined);
    return;
  }

  const doneDir = join(dirs.done, job.id);
  await mkdir(doneDir, { recursive: true });

  // Mark the job in-flight by renaming to <id>.json.processing. This is what
  // the watcher's orphan recovery scans for after a crash, so a job that dies
  // mid-scrape is detectable on restart rather than silently re-run.
  const processingPath = join(dirs.jobs, `${job.id}.json.processing`);
  await rename(jobPath, processingPath).catch(() => undefined);

  const started = runningStatus(deps.now());
  await writeStatus(doneDir, started);

  let exitCode = 1;
  let message: string | null = null;
  try {
    exitCode = await deps.runScrape({
      job,
      outDir: doneDir,
      logPath: join(doneDir, "run.log"),
    });
  } catch (err) {
    // exitCode stays at its initial 1; record the thrown reason.
    message = err instanceof Error ? err.message : String(err);
  }

  // On a non-zero CLI exit, surface the reason from the run log (best-effort)
  // so the API/PWA show "why" rather than a bare "failed".
  if (exitCode !== 0 && message === null) {
    const log = await readFile(join(doneDir, "run.log"), "utf8").catch(() => "");
    message = extractFailureMessage(log);
  }

  await writeStatus(doneDir, finalStatus(started, exitCode, deps.now(), message));
  await rename(processingPath, join(dirs.jobs, `${job.id}.json.done`)).catch(() => undefined);
}
