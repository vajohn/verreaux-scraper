#!/usr/bin/env node
// Mac-side wrapper: scp a job to the Pi over LAN SSH, poll status, download ZIPs.
// Usage: verreaux-scrape-pi <series-url> [-- <extra cli args>] [--probe] [--dry-run]
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildCommands } from "./scrape-pi-lib.mjs";

const HOST = process.env.PI_HOST ?? "pajohn.local";
const USER = process.env.PI_USER ?? "vajohn";
const OUT = "./output";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const probe = argv.includes("--probe");
const url = argv.find((a) => !a.startsWith("-"));
if (!url) { console.error("usage: verreaux-scrape-pi <series-url> [-- <args>] [--probe] [--dry-run]"); process.exit(2); }
const sep = argv.indexOf("--");
const extra = sep === -1 ? "--from 0 --to latest" : argv.slice(sep + 1).join(" ");

const now = new Date();
const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14).replace(/(\d{8})(\d{6})/, "$1-$2");
const id = `${stamp}-${randomBytes(2).toString("hex")}`;
const localJobPath = join(tmpdir(), `${id}.json`);
const cmds = buildCommands({ host: HOST, user: USER, id, localJobPath, outDir: OUT });

// --dry-run prints the plan and exits before ANY I/O (no temp file written).
if (dryRun) { console.log(JSON.stringify(cmds, null, 2)); process.exit(0); }

writeFileSync(localJobPath, JSON.stringify({ id, type: probe ? "probe" : "scrape", url, args: extra }, null, 2));
mkdirSync(OUT, { recursive: true });
console.log(`Uploading job ${id} to ${USER}@${HOST}…`);
execFileSync(cmds.upload[0], cmds.upload.slice(1), { stdio: "inherit" });

console.log("Running remotely; polling…");
const deadline = Date.now() + 120 * 60 * 1000;
let state = "running";
let sshFails = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10000));
  const out = spawnSync(cmds.status[0], cmds.status.slice(1), { encoding: "utf8" });
  if (out.status === 0) {
    sshFails = 0;
    try { state = JSON.parse(out.stdout).state; } catch {}
    process.stdout.write(`  state=${state}\r`);
    if (state === "succeeded" || state === "failed") break;
  } else {
    // status.json may simply not exist yet early on; only warn once the Pi
    // looks persistently unreachable so a wrong host/network isn't silent.
    if (++sshFails % 6 === 0) console.warn(`\n  (Pi unreachable or no status yet — ${sshFails} failed polls)`);
  }
}
console.log(`\nFinal state: ${state}`);
if (state !== "succeeded") {
  spawnSync(cmds.log[0], cmds.log.slice(1), { stdio: "inherit" });
  process.exit(1);
}
// execSync (string) rather than execFileSync+shell:true: shell glob expansion
// for *.zip without the Node 21+ DEP0190 unescaped-args warning. Command is
// built from env + a crypto id, so concatenation is safe here.
execSync(cmds.download.join(" "), { stdio: "inherit" });
console.log(`Done. Saved to ${OUT}/`);
