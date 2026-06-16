# Design: Pi-hosted scraper + webapp-triggered scrape/update (unified)

**Date:** 2026-06-16
**Status:** Approved in brainstorming (pending final spec review)
**Repos:** `verreaux-scraper` (Pi service + CLI) and `verreaux` (PWA)

## Problem

`qimanhwa.com` (and similar Cloudflare-fronted sources) are unreachable from the
corporate Mac because Zscaler filters the Mac's internet egress. The current
workaround runs the scraper on **GitHub Actions** (`scrape.yml`), TOTP-gated,
dispatched and downloaded by a local wrapper (`scrape-remote.mjs`). GitHub was
chosen only because there was no local machine with a clean egress IP.

There is now a Raspberry Pi 4 (`pajohn.local` / `192.168.1.107`) on the home LAN
with its own clean internet egress. We want to:

1. Retire the GitHub job and run scrapes on the Pi in Docker.
2. Let the **PWA** trigger scrapes directly, so a series can be added or
   **updated from its source URL** from inside the reader — not just imported
   from a hand-carried ZIP.

This unifies what were two phases (LAN/CLI first, webapp/HTTP later) into one
design with a clear build order.

### Connectivity facts (verified this session)

- The corporate Mac **already reaches the Pi over the home LAN**: `ping
  pajohn.local` replies from `192.168.1.107`; `ssh vajohn@pajohn.local` reaches
  SSH (only auth was missing). Zscaler filters *internet* egress but lets
  *local LAN* (RFC1918) traffic bypass.
- So **Mac → Pi** works over plain LAN; **Pi → qimanhwa** works via the Pi's
  clean egress. No Tailscale needed for LAN use.
- Tailscale **cannot be installed on the corporate laptop**. For
  away-from-home and browser triggering we use **Tailscale Funnel** (or
  **Cloudflare Tunnel**) to expose the Pi's HTTP API at a public HTTPS URL with
  **no client on the Mac**. A browser cannot SSH, so the PWA path *must* be HTTP.

## Decisions

| Topic | Decision |
| --- | --- |
| Core | **Drop-folder job queue** (`jobs/` in, `done/` out); transport-agnostic |
| Trigger A (CLI) | Mac wrapper over **direct LAN SSH/scp** to `pajohn.local` |
| Trigger B (PWA) | **HTTP API** on the Pi, reachable via Funnel/Tunnel (public HTTPS) or LAN HTTPS |
| Worker | **In-process** — watcher spawns the CLI as a child process |
| Concurrency | **One job at a time** |
| FlareSolverr | **Sidecar container**; scraper points at it by default |
| Scope ported | Scrape job **+ diagnostic probe** |
| Image build | **Native on the Pi** (ARM64) |
| SSH auth | **Key-based** (`ssh-copy-id` once with `PI_4_PASSWORD`) |
| Auth gate | **None on the LAN/SSH path.** **TOTP/token required on the HTTP API** (it can be internet-exposed via Funnel). Reuses `totp.mjs`. |
| ZIP metadata | Scraper embeds **`verreaux.json`** manifest (incl. `sourceUrl`) |
| PWA import | **Two paths**: (1) import a ZIP, (2) add/update **from a source URL** |
| Series model | Add **`sourceUrl`** to `Series` (Dexie **v5** migration) |
| Existing series | **Back-fillable** — user can attach a `sourceUrl` to any already-imported series to unlock updates |
| Update mechanism | Scrape only new chapters, import to a temp series, **merge by order** via existing `mergeSeries` |

## Architecture

```
┌─ Trigger A: Mac CLI (home LAN) ─┐        ┌─ Trigger B: PWA (anywhere) ─┐
│ verreaux-scrape-pi <url> -- ... │        │ "Add from URL" /            │
│   scp job → jobs/               │        │ "Update from source" button │
│   poll status / scp zip ← done/ │        │   fetch POST /scrape (+OTP) │
└──────────────┬──────────────────┘        │   poll /runs/:id            │
               │ LAN SSH                    │   GET /runs/:id/output.zip  │
               │                            └──────────────┬──────────────┘
               │                                           │ HTTPS via
               │                                           │ Funnel / Tunnel
               ▼                                           ▼
        Pi — docker compose (restart: unless-stopped)
        ┌──────────────────────────────────────────────────────────┐
        │ api      small HTTP service: writes jobs/, serves done/    │
        │ worker   pi-watcher.mjs: chokidar jobs/ → spawns CLI child  │
        │ flaresolverr  sidecar (internal http://flaresolverr:8191)   │
        └──────────────────────────────────────────────────────────┘
        bind mounts: ~/verreaux/{jobs,done,state}

   Both triggers write the SAME jobs/ files and read the SAME done/ outputs.
   The worker is identical regardless of which trigger enqueued the job.
```

## Components

### Pi — `~/verreaux/`, docker compose

- **`verreaux-scraper` image** — multi-stage build from `scraper/`. Base
  `mcr.microsoft.com/playwright:v1.52-jammy` (arm64 + Chromium deps);
  `npm ci && npm run build && npx playwright install chromium`. Native deps
  (`better-sqlite3`, `sharp`) compile in-place on ARM64.
- **`worker`** — the image run with the watcher entrypoint
  (`scripts/pi-watcher.mjs`). chokidar watches `jobs/*.json`, processes one job
  at a time, spawns the CLI child. Bind-mounts `jobs/`, `done/`, `state/`.
- **`api`** (new, `scripts/pi-api.mjs`) — minimal HTTP service:
  - `POST /scrape` `{ url, args, type, otp }` → validate OTP, write
    `jobs/<id>.json`, return `{ id }`.
  - `GET /runs/:id` → `status.json`.
  - `GET /runs/:id/log` → run log (tail or SSE stream).
  - `GET /runs/:id/output.zip` → stream the produced ZIP.
  - **CORS** allowing the PWA origin; **OTP gate** on `POST /scrape`.
  - Bind-mounts `jobs/` (write) and `done/` (read), same dirs as the worker.
- **`flaresolverr`** — `ghcr.io/flaresolverr/flaresolverr` (arm64), internal at
  `http://flaresolverr:8191/v1`.
- **Public exposure** — Tailscale Funnel (or Cloudflare Tunnel) maps a public
  HTTPS hostname to the `api` port. LAN HTTPS optional for home-only use.
- **Persistent dirs** — `jobs/`, `done/` (per-run `status.json`, `run.log`,
  `*.zip`, probe artifacts), `state/` (resume SQLite DB; survives restarts).

### Mac — CLI wrapper (`scripts/scrape-pi.mjs`)

Replaces `scrape-remote.mjs`. `verreaux-scrape-pi <url> [-- <args>] [--probe]
[--dry-run]`. Generates `id`, scp's the job to `pi:~/verreaux/jobs/<id>.json`,
polls `done/<id>/status.json` over SSH (~10 s), tails `run.log`, scp's
`done/<id>/*.zip` into `./output/`. Host `PI_HOST` (default `pajohn.local`),
user `PI_USER` (default `vajohn`), key-based SSH. `--dry-run` prints commands.

### Scraper — ZIP manifest (`src/packaging/packager.ts`)

Write **`verreaux.json`** at the ZIP root alongside the series folder:

```json
{
  "schema": 1,
  "sourceUrl": "https://qimanhwa.com/series/office-worker-who-sees-fate",
  "seriesTitle": "Office Worker Who Sees Fate",
  "adapter": "qimanhwa",
  "chapterRange": { "from": 1, "to": 42 },
  "generatedAt": "2026-06-16T15:30:12Z"
}
```

This is what carries the source URL into both PWA import paths. Older ZIPs
without the manifest still import (sourceUrl null).

### PWA — `verreaux` repo

- **DB (`src/db/db.ts`, `types.ts`):** add `sourceUrl: string | null` to
  `Series`. Add **Dexie `version(5)`** with an `upgrade` defaulting existing
  rows to `null`. `series.repo.ts` `createSeries` accepts/sets `sourceUrl`; add
  `setSourceUrl(seriesId, url)`.
- **ZIP import (existing path):** `zipWalker`/`importController` read
  `verreaux.json` if present and set `sourceUrl`; absent → `null` (optionally
  prompt the user to paste it).
- **Back-fill source on existing series:** a "Set source URL" action (e.g. on
  the series screen / overflow menu) lets the user attach a `sourceUrl` to any
  series that has none — including everything imported before this feature
  existed. Calls `setSourceUrl(seriesId, url)`. Once set, **update-from-source**
  becomes available for that series. The field is editable/clearable later. URL
  is lightly validated (well-formed, host matches a known adapter); a wrong URL
  simply fails the next scrape rather than being hard-rejected.
- **Add-from-URL (new import path):** user pastes a series URL → PWA calls
  `POST /scrape` `{ url, args:"--from 0 --to latest", type:"scrape", otp }` →
  polls `/runs/:id` → on success `GET /runs/:id/output.zip` → feed into the
  existing import pipeline → store `sourceUrl`.
- **Update-from-source (new action on a series):** enabled when `sourceUrl` is
  set. Scrape only new chapters: `--from <lastKnownMaxOrder+1> --to latest`
  (the series already tracks `chapterCount`/`lastKnownMaxOrder`). Import the
  returned ZIP into a temporary series, then **merge** into the existing series
  with `computeMergePlan` + `mergeSeries` (conflicts default to keep-existing).
- **Auth UX:** the PWA prompts for the 6-digit OTP before calling the API; the
  service shows `gen`/`now` via `totp.mjs`.

## Data flow & contracts

### Job file `jobs/<id>.json` (`id = YYYYMMDD-HHMMSS-<rand>`)

```json
{ "id": "20260616-153012-ab12", "type": "scrape", "url": "...", "args": "--from 1 --to 10" }
```

`type: "probe"` runs the ported diagnostic (`scripts/pi-probe.mjs`,
consolidating the four `qimanhwa-probe.yml` jobs: curl probe, headless render,
volume/load pattern, API capture) writing artifacts + classification to
`done/<id>/`.

### Status `done/<id>/status.json`

```json
{ "state": "running|succeeded|failed", "startedAt": "...", "finishedAt": "...",
  "exitCode": 0, "message": "..." }
```

### Worker lifecycle per job

1. chokidar detects `jobs/<id>.json`.
2. Atomically rename → `jobs/<id>.json.processing` (restart can detect orphans).
3. `mkdir done/<id>/`; write `status.json` `{state:"running"}`.
4. Run scrape: `node dist/cli/index.js "<url>" <args> --out /work/done/<id>
   --flaresolverr http://flaresolverr:8191/v1 --log-format json --no-color`,
   teeing to `done/<id>/run.log`. (`args` word-splits, matching the GitHub job.)
5. On exit: write final `status.json`; rename job → `.done`.
6. Process the next queued job (strictly serial).

### Trigger resolution

- **CLI:** poll `status.json`; on success scp `*.zip` → `./output/`; on failure
  print `run.log` tail and exit non-zero.
- **PWA:** poll `/runs/:id`; on success `GET /runs/:id/output.zip` → import
  pipeline → (add) store series or (update) merge into existing.

## Error handling

- **Worker crash / Pi reboot:** compose `restart: unless-stopped`; on boot,
  re-scan `*.processing` orphans → mark `status.json` failed ("interrupted").
  Re-enqueue retries safely — CLI resume picks up from `state/`.
- **Bad job JSON:** worker writes `status.json` failed with the parse error
  rather than crashing the watcher.
- **FlareSolverr unreachable:** scraper already treats it as a skipped rung.
- **API auth failure:** `POST /scrape` returns 401 on a bad/expired OTP; the
  PWA surfaces "invalid code."
- **CLI SSH/LAN hiccup:** clear error; job keeps running on the Pi, re-pollable
  by `id`. Overall timeout default 120 min (matches old GH `timeout-minutes`).
- **Update merge conflicts:** same `order` present in both → default
  keep-existing; surfaced in the merge preview if the PWA exposes it.

## Setup (one-time)

1. **SSH key:** `ssh-copy-id vajohn@pajohn.local` (uses `PI_4_PASSWORD` once).
2. **Pi prerequisites:** Docker Engine + compose plugin.
3. **Source + dirs:** clone the scraper repo; `mkdir -p ~/verreaux/{jobs,done,state}`.
4. **TOTP secret:** generate with `node scripts/totp.mjs gen`; set
   `SCRAPE_TOTP_SECRET` in the Pi's compose env for the `api` service.
5. **Build & start:** `docker compose build && docker compose up -d`
   (api + worker + flaresolverr).
6. **Public exposure (for PWA-from-anywhere):** enable Tailscale Funnel (or a
   Cloudflare Tunnel) to the `api` port; note the HTTPS URL for the PWA config.
7. **Mac CLI:** `npm link` exposes `verreaux-scrape-pi`.

## Testing

- **Scraper units (vitest):** job parse/serialize, `id` gen, status state
  machine, `verreaux.json` manifest contents.
- **Worker integration:** drop a json into a temp `jobs/`; assert `status.json`,
  file move, and CLI invocation with the CLI **stubbed**.
- **API integration:** `POST /scrape` with good/bad OTP (201 vs 401); `GET
  /runs/:id` lifecycle; `output.zip` streams the produced file; CORS headers.
- **CLI wrapper:** `--dry-run` asserts exact ssh/scp commands.
- **PWA (vitest):** v5 migration defaults `sourceUrl` to null; ZIP import reads
  `verreaux.json`; back-fill `setSourceUrl` persists and unlocks the update
  action; update flow computes `--from` from `lastKnownMaxOrder` and merges new
  chapters by order (reuse existing merge tests as a template).
- **Manual E2E:** scrape **manhwanex** (no-Cloudflare control) via CLI and via
  PWA add-from-URL; then **qimanhwa**; then **update-from-source** after new
  chapters publish.

## Retirement (after the Pi path passes E2E)

Remove `.github/workflows/scrape.yml`, `.github/workflows/qimanhwa-probe.yml`,
`scripts/scrape-remote.mjs`, and the GitHub `production` env +
`SCRAPE_TOTP_SECRET` secret. `totp.mjs` is **kept** — reused by the Pi `api`
auth gate.

## Suggested build order (still one design)

1. Pi image + compose (worker + flaresolverr) and the **CLI/SSH** trigger — gets
   scraping off GitHub fastest.
2. Scraper **`verreaux.json`** manifest.
3. PWA **`sourceUrl`** field + v5 migration + ZIP-import capture + **back-fill
   "Set source URL"** action for existing series.
4. Pi **`api`** service + Funnel/Tunnel exposure + OTP gate.
5. PWA **add-from-URL** and **update-from-source** actions.
6. Retire the GitHub workflows.

## Open assumptions to confirm

- **Update = incremental** (scrape `from lastKnownMaxOrder+1`), not full
  re-scrape. Full re-scrape remains available via add-from-URL with an explicit
  range.
- **OTP gate stays on even for LAN HTTP** API use (defense in depth), since the
  same service may be Funnel-exposed.
