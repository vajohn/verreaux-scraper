import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processJob, extractFailureMessage } from "../../src/pi/runner.js";
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

  it("marks the job .processing while the scrape runs (for crash recovery)", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j3.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j3", type: "scrape", url: "https://x.test/s" }));

    let sawProcessing = false;
    await processJob(jobPath, dirs, {
      now: () => "2026-06-16T15:30:12Z",
      // The in-flight sentinel must exist at the moment the scrape runs, so a
      // crash here leaves a *.json.processing for the watcher to recover.
      runScrape: async () => {
        sawProcessing = existsSync(join(dirs.jobs, "j3.json.processing"));
        return 0;
      },
    });

    expect(sawProcessing).toBe(true);
    // After success the sentinel is renamed to the terminal .done form.
    expect(readdirSync(dirs.jobs)).toEqual(["j3.json.done"]);
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

  it("flags partial/hasOutput when a rate-limited run (exit 5) left a zip behind", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j6.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j6", type: "scrape", url: "https://x.test/s" }));

    await processJob(jobPath, dirs, {
      now: () => "2026-06-16T15:30:12Z",
      // Simulate the salvage path: the scrape packaged a partial zip, then
      // exited 5 (PARTIAL_RESUME_POSSIBLE).
      runScrape: async ({ outDir }) => {
        writeFileSync(join(outDir, "Test Series.zip"), "PK");
        return 5;
      },
    });

    const status = JSON.parse(readFileSync(join(dirs.done, "j6", "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.exitCode).toBe(5);
    expect(status.partial).toBe(true);
    expect(status.hasOutput).toBe(true);
  });

  it("does not flag partial/hasOutput for a non-zip failure (exit 2)", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j7.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j7", type: "scrape", url: "https://x.test/s" }));

    await processJob(jobPath, dirs, baseDeps(2));

    const status = JSON.parse(readFileSync(join(dirs.done, "j7", "status.json"), "utf8"));
    expect(status.exitCode).toBe(2);
    expect(status.partial).toBe(false);
    expect(status.hasOutput).toBe(false);
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

  it("surfaces the CLI fatal reason from run.log into the failed status", async () => {
    const dirs = makeDirs();
    const jobPath = join(dirs.jobs, "j5.json");
    writeFileSync(jobPath, JSON.stringify({ id: "j5", type: "scrape", url: "https://x.test/s" }));

    await processJob(jobPath, dirs, {
      now: () => "2026-06-16T15:30:12Z",
      // Mimic the real watcher: write the CLI's JSON log, then exit non-zero.
      runScrape: async ({ logPath }) => {
        writeFileSync(
          logPath,
          '{"event":"run.init","payload":{}}\n' +
            '{"event":"run.fatal","payload":{"code":"ERR_EMPTY_RANGE","message":"No chapters found in range [0, 1]."}}\n',
        );
        return 2;
      },
    });

    const status = JSON.parse(readFileSync(join(dirs.done, "j5", "status.json"), "utf8"));
    expect(status.state).toBe("failed");
    expect(status.exitCode).toBe(2);
    expect(status.message).toBe("ERR_EMPTY_RANGE: No chapters found in range [0, 1].");
  });
});

describe("extractFailureMessage", () => {
  it("returns the last run.fatal message with its code", () => {
    const log =
      '{"event":"run.init","payload":{}}\n' +
      '{"event":"run.fatal","payload":{"code":"ERR_EMPTY_RANGE","message":"No chapters found in range [0, 1]."}}\n' +
      '{"event":"cli.summary","payload":{"status":"failed","exitCode":2}}';
    expect(extractFailureMessage(log)).toBe("ERR_EMPTY_RANGE: No chapters found in range [0, 1].");
  });

  it("returns the message without a code when none is present", () => {
    expect(extractFailureMessage('{"event":"run.fatal","payload":{"message":"boom"}}')).toBe("boom");
  });

  it("returns null when there is no fatal line (or junk)", () => {
    expect(extractFailureMessage('{"event":"page.ok"}\nnot json\n')).toBeNull();
    expect(extractFailureMessage("")).toBeNull();
  });
});
