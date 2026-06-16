# Design: Migrate the scrape job from GitHub Actions to a Docker drop-folder service on the Pi

**Date:** 2026-06-16
**Status:** Approved (brainstorming)
**Repo:** `verreaux-scraper`

## Problem

`qimanhwa.com` (and similar Cloudflare-fronted sources) are unreachable from the
corporate Mac because Zscaler filters the Mac's internet egress. The current
workaround runs the scraper on **GitHub Actions** (`scrape.yml`), gated by a
TOTP code, dispatched and downloaded by a local wrapper (`scrape-remote.mjs`).
GitHub was chosen only because there was no local machine with a clean egress IP.

There is now a Raspberry Pi 4 (`pajohn.local` / `192.168.1.107`) on the home LAN
with its own clean internet egress. We want to retire the GitHub job and run the
scrape on the Pi instead.

### Key connectivity facts (verified this session)

- The corporate Mac **can already reach the Pi over the home LAN**:
  `ping pajohn.local` replies from `192.168.1.107`; `ssh vajohn@pajohn.local`
  reaches the SSH service (only auth was missing). Zscaler filters *internet*
  egress but lets *local LAN* (RFC1918) traffic bypass.
- Therefore: **Mac → Pi** works over plain LAN SSH (no Tailscale needed), and
  **Pi → qimanhwa** works via the Pi's own clean egress.
- Tailscale on the Mac is **not required for Phase 1** (it also cannot be
  installed on the locked-down corporate laptop). It is only relevant for
  triggering from outside the home network, which is **Phase 2 (future)**.

## Decisions (from brainstorming)

| Topic | Decision |
| --- | --- |
| Trigger model | **Drop-folder job queue** (`jobs/` in, `done/` out) — transport-agnostic core |
| Phase 1 transport | **Direct LAN SSH/scp** to `pajohn.local` (no Tailscale, no new Mac software) |
| Phase 2 transport (future) | Optional **HTTP service + Tailscale Funnel / Cloudflare Tunnel** writing to the *same* `jobs/` queue; re-adds an auth gate |
| Auth gate (TOTP) | **Dropped for Phase 1** — LAN + SSH credentials are the gate. Re-added only with Phase 2's public HTTP front-end |
| Scope ported | **Scrape job + diagnostic probe** (both `scrape.yml` and `qimanhwa-probe.yml`) |
| FlareSolverr | **Yes — sidecar container** on the Pi; scraper points at it by default |
| Worker model | **In-process** — watcher spawns the CLI as a child process (no docker-in-docker) |
| Job concurrency | **Single job at a time** (Cloudflare politeness + Pi resources) |
| Image build | **Built natively on the Pi** (ARM64; native deps compile in-place) |
| SSH auth | **Key-based** — `ssh-copy-id` once using `PI_4_PASSWORD`, key auth thereafter |

## Architecture

```
Mac (corporate / Zscaler net)                  Pi (home LAN, clean egress)
─────────────────────────────                  ─────────────────────────────────────
verreaux-scrape-pi <url> -- <args>             docker compose (restart: unless-stopped)
  │ 1. write job json                            ┌──────────────────────────────────┐
  │    scp → pi:~/verreaux/jobs/<id>.json  ─────► │ worker (verreaux-scraper image)    │
  │ 2. poll done/<id>/status.json (ssh)  ◄─────── │  pi-watcher.mjs: chokidar jobs/    │
  │ 3. tail done/<id>/run.log (live)              │  spawns CLI child, writes done/<id>│
  │ 4. scp done/<id>/*.zip → ./output    ◄─────── │                                    │
  ▼                                               │ flaresolverr (sidecar, internal)   │
results in ./output/                              └──────────────────────────────────┘
                                            bind mounts: ~/verreaux/{jobs,done,state}

         ── Phase 2 (future) bolts on here, same jobs/ + done/ contract ──
         HTTP service on Pi  ⇄  Tailscale Funnel / Cloudflare Tunnel  ⇄  Mac (HTTPS + OTP)
```

**Stable core:** the `jobs/` + `done/` directory contract and the worker are
transport-agnostic. Phase 1 (SSH/scp wrapper) and Phase 2 (HTTP front-end) are
just different writers/readers of the same queue. The worker never changes
between phases.

## Components

### On the Pi, under `~/verreaux/`

- **`verreaux-scraper` Docker image** — multi-stage build from the existing
  `scraper/` source. Base on `mcr.microsoft.com/playwright:v1.52-jammy`
  (ships arm64 + Chromium system deps). Build steps: `npm ci`,
  `npm run build`, `npx playwright install chromium`. Native deps
  (`better-sqlite3`, `sharp`) compile in-place on ARM64.
- **`docker-compose.yml`** — two services:
  - **`worker`** — the image above, run with the watcher entrypoint
    (`scripts/pi-watcher.mjs`). Bind-mounts `jobs/`, `done/`, `state/`.
    Connected to the same compose network as FlareSolverr.
  - **`flaresolverr`** — `ghcr.io/flaresolverr/flaresolverr` (arm64),
    reachable internally at `http://flaresolverr:8191/v1` (no host port needed).
- **Persistent host dirs (bind-mounted):**
  - `jobs/` — incoming job files.
  - `done/` — per-run output (`status.json`, `run.log`, `*.zip`, probe artifacts).
  - `state/` — the resume SQLite DB, so CLI resume survives container restarts.

### On the Mac

- **`scripts/scrape-pi.mjs`** — new wrapper, replacing `scrape-remote.mjs`'s role.
  - CLI: `verreaux-scrape-pi <series-url> [-- <extra cli args>] [--probe] [--dry-run]`
  - Behavior: generate `id`, write job json, `scp` it to
    `pi:~/verreaux/jobs/<id>.json`, poll `done/<id>/status.json` over SSH
    (~10 s interval), tail `run.log` for live progress, then `scp`
    `done/<id>/*.zip` into `./output/`.
  - Host from `PI_HOST` env, default `pajohn.local`; user from `PI_USER`,
    default `vajohn`. Key-based SSH.
  - `--dry-run` prints the ssh/scp commands without executing.

## Data flow & contracts

### Job file `jobs/<id>.json`

`id` = `YYYYMMDD-HHMMSS-<rand>` (sortable, unique).

```json
{
  "id": "20260616-153012-ab12",
  "type": "scrape",
  "url": "https://qimanhwa.com/series/office-worker-who-sees-fate",
  "args": "--from 1 --to 10"
}
```

- `type: "scrape"` → run the CLI.
- `type: "probe"` → run the ported diagnostic (`scripts/pi-probe.mjs`), which
  consolidates the four `qimanhwa-probe.yml` jobs (curl probe, headless render,
  volume/load pattern, API capture) and writes the same html/png/json artifacts
  plus a classification summary into `done/<id>/`.

### Status file `done/<id>/status.json`

```json
{ "state": "running" | "succeeded" | "failed",
  "startedAt": "...", "finishedAt": "...", "exitCode": 0, "message": "..." }
```

### Worker lifecycle per job

1. Detect `jobs/<id>.json` via chokidar `add`.
2. Atomically rename `jobs/<id>.json` → `jobs/<id>.json.processing` (lets a
   restart detect orphans).
3. `mkdir done/<id>/`; write `status.json` `{state:"running", startedAt}`.
4. Run (scrape):
   `node dist/cli/index.js "<url>" <args> --out /work/done/<id> --flaresolverr http://flaresolverr:8191/v1 --log-format json --no-color`,
   teeing stdout/stderr to `done/<id>/run.log`. (`args` word-splits, matching
   the GitHub job's intentional unquoted `EXTRA_ARGS`.)
5. On exit: write `status.json` `{state, exitCode, finishedAt}`; rename job file
   → `jobs/<id>.json.done`.
6. Process the next queued job (strictly one at a time).

### Mac wrapper resolution

- Poll `status.json`; on `succeeded`, `scp done/<id>/*.zip ./output/`; on
  `failed`, print the tail of `run.log` and exit non-zero. Still "feels like a
  local download," matching today's `scrape-remote.mjs` UX.

## Error handling

- **Worker crash / Pi reboot:** compose `restart: unless-stopped`. On boot the
  watcher re-scans `*.processing` orphans and marks their `status.json` as
  `failed` with an "interrupted" message. Re-dropping the job retries safely —
  the CLI's own resume picks up from `state/`.
- **Bad job JSON:** worker writes `status.json` `failed` with the parse error
  rather than crashing the watcher loop.
- **FlareSolverr unreachable:** the scraper already treats it as a skipped rung
  (`cf.flaresolverr.unavailable`); no special handling.
- **SSH/LAN hiccup on the Mac:** clear error message; the job keeps running on
  the Pi and can be re-polled by `id`. Configurable overall timeout
  (default 120 min, matching the old GH `timeout-minutes: 120`).
- **Ctrl-C on the wrapper:** leaves the job running on the Pi (idempotent);
  re-running the wrapper against the same `id` re-attaches to polling.

## Setup (one-time)

1. **SSH key:** `ssh-copy-id vajohn@pajohn.local` (uses `PI_4_PASSWORD` once);
   key-based thereafter.
2. **Pi prerequisites:** install Docker Engine + compose plugin if absent.
3. **Source + dirs on Pi:** clone/copy the scraper repo;
   `mkdir -p ~/verreaux/{jobs,done,state}`.
4. **Build & start:** `docker compose build && docker compose up -d`
   (worker + flaresolverr).
5. **Mac wrapper:** `npm link` (or global install) exposes `verreaux-scrape-pi`.

## Testing

- **Unit (vitest, existing harness):** job parse/serialize, `id` generation,
  status state-machine transitions.
- **Worker integration:** drop a json into a temp `jobs/` dir; assert the worker
  writes `status.json`, moves the job file, and invokes the CLI — with the CLI
  command **stubbed** so the test is hermetic.
- **Wrapper:** `--dry-run` asserts the exact ssh/scp commands.
- **Manual E2E:** scrape **manhwanex** (no-Cloudflare control) end-to-end through
  the Pi and confirm a ZIP lands in `./output/`; then **qimanhwa** (the real
  target) to validate FlareSolverr + clean egress.

## Retirement (after Pi path passes E2E)

Keep the GitHub workflows as a fallback until the Pi path is validated, then
remove:

- `.github/workflows/scrape.yml`
- `.github/workflows/qimanhwa-probe.yml`
- `scripts/scrape-remote.mjs`
- the `production` environment + `SCRAPE_TOTP_SECRET` secret

`scripts/totp.mjs` may be kept (harmless, dependency-free) or removed; it is not
used by the Phase 1 Pi path. It would be reused if Phase 2 re-adds an auth gate.

## Out of scope (Phase 2, future)

- HTTP trigger service on the Pi writing to the same `jobs/` queue.
- Public exposure via Tailscale Funnel or Cloudflare Tunnel for
  away-from-home triggering.
- An auth gate (TOTP or token) in front of that public HTTP endpoint.

These are explicitly deferred; the Phase 1 worker/queue contract is designed so
they can be added without reworking the worker.
