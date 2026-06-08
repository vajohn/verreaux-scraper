# verreaux-scrape

Multi-source manhwa/manga scraper that produces Verreaux-compatible Type 2 ZIPs for offline reading.

## Supported sources

| Host                                                    | Adapter     | Status         |
| ------------------------------------------------------- | ----------- | -------------- |
| `asurascans.com` / `asuracomic.net` / `asuratoon.com`   | AsuraScans  | live-verified  |
| `manhuaplus.org`                                        | ManhuaPlus  | mocked only    |
| `arenascan.com`                                         | Arenascan   | live-verified  |
| `drakecomic.org`                                        | Drake Scans | fixture-tested · requires `--allow-headed-cloudflare` |
| `manhwanex.com`                                         | manhwanex   | Working        |
| `qimanhwa.com`                                          | qimanhwa    | via GitHub Actions (Zscaler-blocked locally) |

## Requirements

- Node.js **>= 20**
- macOS, Linux, or WSL (Playwright Chromium is downloaded on first run)
- Optional: [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) for harder Cloudflare challenges

## Install

```sh
npm install
npm run build
npm link          # installs verreaux-scrape into PATH from this checkout
```

Or run directly without linking:

```sh
node dist/cli/index.js <series-url> [options]
# -- or --
npx --yes verreaux-scrape <series-url> [options]
```

## Worked examples

Download all available chapters of "The Max Level Player's 100th Regression":

```sh
verreaux-scrape https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a --to latest
```

Download chapters 0 through 83 of the ManhuaPlus mirror:

```sh
verreaux-scrape https://manhuaplus.org/manga/the-100th-regression-of-the-max-level-player --from 0 --to 83
```

Download a single chapter (set `--from` and `--to` to the same number; both are inclusive):

```sh
verreaux-scrape https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a --from 5 --to 5
```

Download an arbitrary, non-contiguous set of chapters:

```sh
verreaux-scrape https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a --chapters 5,12,40
```

`--chapters` accepts a comma-separated list of non-negative integers. The list is deduplicated and sorted automatically, so `--chapters 40,5,12,5` is equivalent to `--chapters 5,12,40`. Chapters that don't exist at the source are silently skipped; if **none** of the requested chapters exist the run aborts with an empty-range error. `--chapters` cannot be combined with `--from` or `--to`.

### Sources with scanlation groups

Some sources host multiple scanlator versions of the same series. For those, the scraper exposes `--group` and `--list-groups`. Use `--list-groups` to inspect what's available, then rerun with `--group <name|id>`. The flag accepts a name (case-insensitive), slug, or numeric id from the `--list-groups` output. If the series only has one group, selection happens automatically. If multiple groups exist and you omit `--group`, the scraper prompts on TTY or exits with code 2 in non-interactive contexts.

A group may not cover the entire chapter range — it might start mid-series, stop early, or skip individual chapters. The scraper warns about these gaps before downloading. Pass `--allow-partial-zip` to proceed and produce a ZIP that omits the missing chapters; without it, the run halts at the first failure with exit code 5 (resumable).

## Concurrent downloads

Use `--concurrency <n>` to fetch multiple chapters in parallel. Range is `1-3` (capped to stay polite and avoid Cloudflare flagging).

```sh
verreaux-scrape https://asurascans.com/comics/the-max-level-players-100th-regression-030ff47a \
  --from 0 --to 83 \
  --concurrency 3 \
  --out ~/Downloads
```

What `--concurrency` controls:

- Chapter-level parallelism — how many chapter pipelines run at once.
- Image fetches within a chapter are throttled separately (max 5 in flight per image host).
- Per-host request throttle (~2 req/s) and the Cloudflare mutex apply globally regardless of this flag.
- SQLite state and cookie-jar writes are serialized — concurrency cannot corrupt state.

Recommended values:

| Goal                            | `--concurrency` |
| ------------------------------- | --------------- |
| Conservative / first run        | `1` (default)   |
| Normal use                      | `2`             |
| Maximum throughput              | `3`             |

If you see `cf.detected` events or 429 warnings, drop back to `1` or `2`.

## CLI reference

```
verreaux-scrape <series-url> [options]

Options:
  --from <n>                    First chapter number (inclusive). Default: 0
  --to <n|latest>               Last chapter number (inclusive) or 'latest'. Default: latest
  --chapters <list>             Comma-separated chapter numbers (e.g. 5,12,40). Overrides --from/--to.
  --out <path>                  Output directory. Default: ./dist
  --format <webp|jpg|png|original>  Image format preference. Default: original
  --concurrency <n>             Chapters in parallel. Range 1-3. Default: 1
  --resume                      Resume a partial run for this series-url
  --refresh-cover               Force re-fetch of the series cover (overrides SHA-1 cache)
  --allow-partial-zip           Build ZIP even if some chapters failed
  --allow-headed-cloudflare     Open a visible browser for human CF challenge resolution
  --flaresolverr <url>          FlareSolverr endpoint. Default: http://localhost:8191/v1
  --log-level <level>           debug|info|warn|error. Default: info
  --log-format <json|pretty>    Default: pretty
  --no-color                    Disable colored output
  --group <name|id>             Scanlation group to download from (sites that expose groups)
  --list-groups                 Print available groups for the series and exit
  --version
  --help
```

## Exit code reference

| Code | Name             | Meaning                                                   |
|------|------------------|-----------------------------------------------------------|
| 0    | OK               | All selected chapters downloaded, packaged, validated.    |
| 1    | GENERIC          | Unclassified error; check logs.                           |
| 2    | CONFIG           | Bad CLI args, unwritable output dir, or invalid range.    |
| 3    | AUTH_CF          | Cloudflare challenge could not be bypassed.               |
| 4    | SOURCE_NOT_FOUND | Source dead, series missing, or unknown host.             |
| 5    | PARTIAL          | Some chapters downloaded but not all; resume possible.    |
| 6    | PARSER           | Adapter parser failed — source structure changed.         |
| 7    | PACKAGE_INVALID  | Internal — produced ZIP violates output contract.         |
| 130  | INTERRUPTED      | SIGINT (Ctrl-C).                                          |

## Output ZIP layout

The produced ZIP is a Verreaux-compatible Type 2 import. Import it via the PWA's import dialog.

```
<Series Title>/
  cover.webp            (or .jpg / .png)
  Chapter 001/
    001.png
    002.png
    ...
  Chapter 002/
    ...
```

## FlareSolverr setup

If a site is protected by Cloudflare, install FlareSolverr to solve challenges automatically:

```sh
docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr
```

The scraper probes `http://localhost:8191/v1` by default. Pass `--flaresolverr <url>` to override.

## Resume behavior

Pass `--resume` to pick up where the previous run for the same `series-url` left off. The flag does
two things:

1. **Reuses the prior run's `run_id`** from the SQLite cache at `<out>/.verreaux-cache/` instead of
   starting a fresh run. This is what lets the scraper find previously-completed chapters.
2. **Skips chapters whose state is `DONE`** in the cache, and within a chapter, skips pages whose
   state is `DONE` (SHA-1 + byte length already recorded).

You must use the **same `--out` directory** as the original run — the resume lookup reads the
SQLite DB at `<out>/.verreaux-cache/state.sqlite`. Changing `--out` starts a fresh run from scratch.

A resume operation:

```sh
verreaux-scrape <same-series-url> [same-flags] --resume --out <same-out>
```

When you see `Resuming prior run  id=… fromState=…` at the top of the output, the resume found the
prior run. If you don't see that line, the cache wasn't found — verify `--out` matches.

Failed chapters are reset to `PENDING` on resume and will be re-attempted. Only `DONE` state is
preserved; intermediate states (`RESOLVING`, `DOWNLOADING`, etc.) are rolled back, so chapters that
were mid-flight when the previous run died will retry cleanly.

## Content note

Mature content passes through unfiltered. NSFW splash screens are auto-dismissed via bypass cookies.

## Development

```sh
npm run dev          # tsx watch
npm test             # vitest run
npm run test:watch   # vitest interactive
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

## Corporate networks (Zscaler / MITM proxies)

If `npm install` or live downloads fail with `unable to get local issuer certificate`:

- The CLI auto-loads system PEM bundles from `/etc/ssl/cert.pem`, `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, and `NODE_EXTRA_CA_CERTS` at startup. Most corporate setups Just Work after a fresh `npm run build`.
- As a fallback, set `NODE_TLS_REJECT_UNAUTHORIZED=0` for the single command (not globally):

```sh
NODE_TLS_REJECT_UNAUTHORIZED=0 verreaux-scrape <url> --out ~/Downloads
```

**qimanhwa.com** is blocked by Katim's Zscaler under the "Online and Other Games"
category and cannot be scraped from the corporate network. Scrape it via the
TOTP-gated GitHub Actions workflow using the local wrapper:

    node scripts/scrape-remote.mjs https://qimanhwa.com/series/<slug> -- --from 1 --to 10

After `npm link` (or a global install) the same wrapper is available as a command:

    verreaux-scrape-remote https://qimanhwa.com/series/<slug> -- --from 1 --to 10

You'll be prompted for your authenticator code; the wrapper dispatches the remote
run, waits, and downloads the resulting ZIP(s) into ./output — so it feels like a
local download even though the work runs on GitHub. Output ZIPs are also kept as a
build artifact for 7 days.

## Native build note

`better-sqlite3` requires a native addon. If installation fails on Apple Silicon with a `node-gyp` error, run:

```sh
npm install --build-from-source better-sqlite3
```

If `node-gyp` itself is missing:

```sh
npm install -g node-gyp
xcode-select --install
```

Then retry `npm install`.

## Spec

Full specification: [docs/workflow.md](docs/workflow.md). The spec is authoritative. All implementation decisions defer to it.
