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

  await writeStatus(doneDir, finalStatus(started, exitCode, deps.now(), message));
  await rename(jobPath, join(dirs.jobs, `${job.id}.json.done`)).catch(() => undefined);
}
