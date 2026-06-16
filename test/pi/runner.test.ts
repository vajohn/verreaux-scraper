import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processJob } from "../../src/pi/runner.js";
import type { RunnerDeps } from "../../src/pi/runner.js";

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), "pi-runner-"));
  const jobs = join(root, "jobs");
  const done = join(root, "done");
  const state = join(root, "state");
  for (const d of [jobs, done, state]) mkdirSync(d);
  return { root, jobs, done, state };
}

const baseDeps = (exitCode: number): RunnerDeps => ({
  now: () => "2026-06-16T15:30:12Z",
  runScrape: async ({ outDir }) => {
    writeFileSync(join(outDir, "ran.txt"), "ok");
    return exitCode;
  },
});

describe("processJob", () => {
  it("runs a scrape and writes a succeeded status", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j1.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j1", type: "scrape", url: "https://x.test/s", args: "--from 0 --to latest" }));

    await processJob(jobPath, dirs, baseDeps(0));

    const status = JSON.parse(readFileSync(join(dirs.done, "j1", "status.json"), "utf8"));
    expect(status.state).toBe("succeeded");
    expect(status.exitCode).toBe(0);
    expect(existsSync(join(dirs.done, "j1", "ran.txt"))).toBe(true);
    expect(readdirSync(dirs.jobs)).toEqual(["j1.json.done"]);
  });

  it("writes a failed status on non-zero exit", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j2.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j2", type: "scrape", url: "https://x.test/s" }));

    await processJob(jobPath, dirs, baseDeps(5));

    const status = JSON.parse(readFileSync(join(dirs.done, "j2", "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.exitCode).toBe(5);
    expect(readdirSync(dirs.jobs)).toEqual(["j2.json.done"]);
  });

  it("writes a failed status for an unparseable job without throwing", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "bad.json");
    writeFileSync(jobPath, "{not json");

    await expect(processJob(jobPath, dirs, baseDeps(0))).resolves.toBeUndefined();
    expect(readdirSync(dirs.jobs)).toEqual(["bad.json.done"]);
    const failed = JSON.parse(readFileSync(join(dirs.done, "bad", "status.json"), "utf8"));
    expect(failed.state).toBe("failed");
  });
});
