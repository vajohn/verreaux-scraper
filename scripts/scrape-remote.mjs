#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scrape-remote.mjs — local wrapper around the TOTP-gated `scrape` workflow.
//
// Scrapes a source that is unreachable locally (e.g. qimanhwa, blocked by
// Zscaler) by running it on GitHub Actions, then downloads the result to
// ./output. From the user's side it looks like a local download.
//
// Requires the GitHub CLI (`gh`) authenticated with write access to the repo.
//
// Usage:
//   node scripts/scrape-remote.mjs <series-url> [-- <extra cli args>]
//   e.g. node scripts/scrape-remote.mjs https://qimanhwa.com/series/x -- --from 1 --to 10
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts }).trim();
}

// Read a 6-digit code without echoing it to the terminal.
function promptCode(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let val = "";
    const done = () => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolve(val.trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (code === 10 || code === 13 || code === 4) return done(); // Enter / EOT
        if (code === 3) { process.stdout.write("\n"); process.exit(1); } // Ctrl-C
        if (code === 127 || code === 8) { val = val.slice(0, -1); continue; } // backspace
        val += ch;
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const url = process.argv[2];
if (!url || url.startsWith("-")) {
  console.error("usage: scrape-remote.mjs <series-url> [-- <extra cli args>]");
  process.exit(2);
}
const sepIdx = process.argv.indexOf("--");
const extraArgs = sepIdx === -1 ? "--from 0 --to latest" : process.argv.slice(sepIdx + 1).join(" ");

const code = await promptCode("Authenticator code: ");
if (!/^\d{6}$/.test(code)) {
  console.error("Expected a 6-digit code.");
  process.exit(2);
}

console.log("Connecting…");
gh([
  "workflow", "run", "scrape.yml", "--ref", "main",
  "-f", `url=${url}`, "-f", `args=${extraArgs}`, "-f", `otp=${code}`,
]);

// The dispatched run takes a moment to register; grab the newest run id.
await new Promise((r) => setTimeout(r, 6000));
const runId = gh([
  "run", "list", "--workflow=scrape.yml", "--event=workflow_dispatch",
  "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId",
]);
if (!runId) { console.error("Could not locate the dispatched run."); process.exit(1); }

// Stream progress; non-zero exit means the OTP gate or the scrape failed.
console.log("Downloading… (this runs remotely; please wait)");
const watch = spawnSync("gh", ["run", "watch", runId, "--exit-status", "--interval", "15"], {
  stdio: "inherit",
});
if (watch.status !== 0) {
  console.error("Failed — invalid code or scrape error. See the run output above.");
  process.exit(1);
}

gh(["run", "download", runId, "-n", "scrape-output", "-D", "./output"]);
console.log("\nDone. Saved to ./output/");
