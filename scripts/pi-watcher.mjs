// scripts/pi-watcher.mjs
// Long-running worker entrypoint. Watches the jobs dir, processes one job at a
// time via the tested processJob core, spawning the built CLI for real scrapes.
import chokidar from "chokidar";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, renameSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { processJob } from "../dist/pi/runner.js";

const ROOT = process.env.VERREAUX_ROOT ?? "/work";
const dirs = { jobs: join(ROOT, "jobs"), done: join(ROOT, "done"), state: join(ROOT, "state") };
const FLARESOLVERR = process.env.FLARESOLVERR_URL ?? "http://flaresolverr:8191/v1";
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli", "index.js");

const deps = {
  now: () => new Date().toISOString(),
  runScrape: ({ job, outDir, logPath }) =>
    new Promise((resolve) => {
      const log = createWriteStream(logPath);
      // EXTRA args word-split intentionally, matching the old GitHub job.
      // Trim first so surrounding/internal whitespace can't yield empty-string
      // argv tokens (e.g. "  --to latest  ").
      const trimmed = job.args.trim();
      const extra = trimmed ? trimmed.split(/\s+/) : [];
      const argv =
        job.type === "probe"
          ? [join(here, "pi-probe.mjs"), job.url, "--out", outDir]
          : [CLI, job.url, ...extra, "--out", outDir, "--flaresolverr", FLARESOLVERR, "--log-format", "json", "--no-color"];
      const child = spawn("node", argv, { env: { ...process.env, CI: "true" } });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", (err) => {
        log.write(`spawn error: ${err.message}\n`);
        resolve(1);
      });
    }),
};

// Serial queue: never run two scrapes at once.
let chain = Promise.resolve();
function enqueue(jobPath) {
  chain = chain.then(() => processJob(jobPath, dirs, deps).catch((e) => console.error("processJob crashed:", e)));
}

// Orphan recovery: anything left in *.processing from a crash is failed out.
async function recoverOrphans() {
  // Ensure the working dirs exist so a cold start (before any volume is
  // populated) doesn't crash on readdir/ENOENT before the watcher installs.
  for (const d of [dirs.jobs, dirs.done, dirs.state]) {
    await mkdir(d, { recursive: true }).catch(() => {});
  }
  for (const f of readdirSync(dirs.jobs).filter((f) => f.endsWith(".json.processing"))) {
    const id = f.replace(/\.json\.processing$/, "");
    const doneDir = join(dirs.done, id);
    await mkdir(doneDir, { recursive: true }).catch(() => {});
    await writeFile(
      join(doneDir, "status.json"),
      JSON.stringify({ state: "failed", message: "interrupted by restart", exitCode: 1, startedAt: null, finishedAt: new Date().toISOString() }, null, 2),
    ).catch(() => {});
    if (existsSync(join(dirs.jobs, f))) renameSync(join(dirs.jobs, f), join(dirs.jobs, `${id}.json.done`));
  }
}

await recoverOrphans();
console.log(`[pi-watcher] watching ${dirs.jobs}`);
// chokidar v4: watch the directory (no globs), filter in the handler.
chokidar
  .watch(dirs.jobs, { ignoreInitial: false, depth: 0, awaitWriteFinish: { stabilityThreshold: 500 } })
  .on("error", (err) => console.error("[pi-watcher] chokidar error:", err))
  .on("add", (p) => {
    const name = basename(p);
    // Only pick up fresh job files; ignore the *.processing/*.done sentinels.
    if (name.endsWith(".json")) enqueue(p);
  });
