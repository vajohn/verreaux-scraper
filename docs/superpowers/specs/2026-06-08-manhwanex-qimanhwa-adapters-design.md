# Design: manhwanex + qimanhwa adapters (GitHub-Actions execution model)

- **Date:** 2026-06-08
- **Status:** Approved (brainstorm complete; awaiting spec review before plan)
- **Scope:** One spec, four pieces, all fully deliverable. The earlier egress-bypass
  (SOCKS5 proxy) approach was **dropped** after GitHub-Actions probes proved both
  sites are reachable off the corporate network without a proxy.

---

## Background and findings

The scraper today has five working adapters (asurascans, manhuaplus, arenascan,
drake, hivetoons), all parsing server-rendered HTML / inline JSON and all tested
against captured fixtures. We are adding two sources: **manhwanex.com** and
**qimanhwa.com**.

All findings below were established empirically on 2026-06-08 — locally (behind
Katim Zscaler) and from GitHub-hosted Actions runners (Azure datacenter IPs, off
the corporate network). The probe workflow lives at
`.github/workflows/qimanhwa-probe.yml`.

### The corporate-network problem (why local scraping fails for qimanhwa)
- Every site is TLS-intercepted by Zscaler (certs `O=Zscaler Inc.`, issuer `KATIM
  LLC / SMARTPROXY-UAE`); the system keychain already trusts it, so `systemCa.ts`
  handles the cert transparently.
- **manhwanex.com** passes Zscaler policy → `200`.
- **qimanhwa.com** is blocked by Zscaler policy: `403`, `Server: Zscaler/6.2`,
  block text *"Not allowed to browse Online and Other Games category"* under
  Katim's AUP. For real browsers it is routed through Zscaler **Cloud Browser
  Isolation** (the user's "captured" HTML was the CBI client, not qimanhwa). It is
  therefore unreachable and unscrapeable from the corporate network by any local
  means. (A recategorization request to Katim IT remains a valid parallel path but
  is out of our control and not depended upon here.)

### The GitHub-Actions solution (proven)
Running from GitHub-hosted runners removes Zscaler entirely (off-network). Probe
results:
- **manhwanex.com** → `200` (LiteSpeed, no Cloudflare).
- **qimanhwa.com** via bare curl → `403 cf-mitigated: challenge` (Cloudflare JS
  challenge, *not* a hard block).
- **qimanhwa.com** via headless Chromium + stealth (the `BrowserPool` stack) →
  `200`, real content rendered. The initial challenge is auto-cleared; the
  `cf_clearance` cookie then carries the session.
- **Volume probe** (home → series → 6 chapters, sequential full reloads from one
  datacenter IP) → **8/8 `200`, zero challenges/rate-limits**. Sustained scraping
  from a GitHub IP is viable. ~5–9 s per page.

**Conclusion:** execute the scraper on GitHub Actions. No proxy, no FlareSolverr,
no residential egress needed. The per-host SOCKS5 egress-bypass from the prior
draft is removed.

### manhwanex.com — Madara WordPress theme
- `wp-content/themes/madara`, `wp-manga`, `admin-ajax.php`, `WordPress 7.0`.
  LiteSpeed, **no Cloudflare**.
- Series `/manga/<slug>/` shows only a 3-chapter "latest" preview in the static
  DOM; the **full chapter list is AJAX-loaded** from the modern Madara endpoint
  **`POST /manga/<slug>/ajax/chapters/`**, which returns an HTML fragment of
  `<li class="wp-manga-chapter">` entries. (The classic `admin-ajax.php?action=
  manga_get_chapters` endpoint is **dead** on this site — returns `400`.) Title
  `.post-title h1`, cover `.summary_image img`.
- Chapter images in `.reading-content img` — server-rendered with a plain `src`
  (note: the captured fixture's `src` has a leading space, so values are trimmed).
- Reachable today via plain `ctx.http.get`/`post`; no browser/CF path required.

### qimanhwa.com — Angular SSR SPA on the "ezmanga/qiscans" platform, JSON API
- Angular Universal (SSR) app (`_ngcontent-ng-*`, `<script id="ng-state">`). Pages
  arrive fully server-rendered; the SSR server embeds the API responses in an
  Angular **TransferState** blob (`<script id="ng-state" type="application/json">`).
- **REST API base: `https://api.qimanhwa.com/api/v1`** (confirmed from the `u`
  field inside cached `ng-state` entries). Each cached entry has shape
  `{ b: <body>, h: <headers>, s: <status>, st, u: <url>, rt: "json" }`.
- Endpoints (confirmed from real captures):
  - `GET /api/v1/series/<slug>` — series metadata (title, cover).
  - `GET /api/v1/series/<slug>/chapters` → `{ data: [ { id, slug:"chapter-178",
    number:178, title, cover, price, isFree, publishStatus, createdAt, … } ] }`.
  - `GET /api/v1/series/<slug>/chapters/<chapter-slug>` → `{ id, slug, number,
    images: [ { url, … } ], isFree, requiresPurchase, price, publishStatus, … }`.
- **URL scheme:** series `/series/<slug>`, chapter `/series/<slug>/chapter-<n>`.
- **Images:** served from a media CDN (`media.qimanhwa.com/file/qiscans/…webp`
  observed). The adapter reads `images[].url` verbatim regardless of host.
- **Paywall:** chapters carry `price` / `isFree` / `requiresPurchase`. Locked
  chapters (`isFree:false`) cannot be downloaded without authentication/purchase.
  None of the existing adapters model a paywall — this one must.

### Decisions taken during brainstorm
- Sequencing: build manhwanex + qimanhwa now; both fully specified (no gate).
- Execution model: **GitHub Actions**. Drop the SOCKS5 egress-bypass and its deps.
- qimanhwa parser: **API-first** against `api.qimanhwa.com/api/v1`, with the
  rendered-page `ng-state` TransferState blob as fallback.

---

## Piece 1 — `SourceAdapter` id union (shared)

Extend the closed union in `src/core/types.ts` (`"asurascans" | "manhuaplus" |
"arenascan" | "drake" | "hivetoons"`) to add `"manhwanex" | "qimanhwa"`. Register
both singletons in `src/adapters/index.ts`'s `adapterRegistry`. No other id-union
references exist in `src/`.

---

## Piece 2 — manhwanex adapter (Madara)

**Files:** `src/adapters/manhwanex.ts`, `manhwanex.helpers.ts`,
`test/manhwanex.adapter.test.ts`, `test/manhwanex.helpers.test.ts`. Modeled on the
drake pair (pure parsers in helpers; adapter orchestrates).

**Constants:** `SOURCE_ID="manhwanex"`, `PRIMARY_HOST="manhwanex.com"`,
`ORIGIN="https://manhwanex.com"`. `matchHost` strips `www.`. `domainAliases()`→`[]`.
`liveDomain()`→`PRIMARY_HOST`.

- **`resolveSeries`**: GET the series page (plain `ctx.http.get`) for title
  (`.post-title h1`) and cover (`.summary_image img`, prefer `data-src` then
  `src`), referer `ORIGIN+"/"`. Then **`POST {seriesUrl}ajax/chapters/`** (modern
  Madara) and parse the returned `<li class="wp-manga-chapter">` fragment →
  `preEnumeratedChapters` (number+url, sorted ascending).
- **`enumerateChapters`** — return `preEnumeratedChapters` else re-run
  `resolveSeries` (stripping the `adapter.id:` prefix from `seriesId` first).
- **`parseChapterImages`** — `.reading-content img`, value `data-src ?? src`
  **trimmed**, DOM order, 1-based `pageIndex`, `referer = imageRefererFor(chapter)`.
- **`imageRefererFor`** → `chapter.chapterUrl`.
- **`dismissNsfwSplash`** → no-op (set `wpmanga-adult` cookies only if a real gate
  appears in a fixture).
- No `fetchChapter`/`fetchImage`, no browser/CF path.

**Tests:** real fixtures in `test/fixtures/manhwanex/` — `series.html` (title/cover),
`chapters-ajax.html` (the `ajax/chapters` fragment), `chapter.html` (reader page);
unit-test helpers + adapter (title/cover, chapter parse + ascending sort, correct
`ajax/chapters` POST URL, trimmed reader-image extraction), matching existing
fixture-based tests.

---

## Piece 3 — qimanhwa adapter (Angular SSR / JSON API)

**Files:** `src/adapters/qimanhwa.ts`, `qimanhwa.helpers.ts`,
`test/qimanhwa.adapter.test.ts`, `test/qimanhwa.helpers.test.ts`.

**Constants:** `SOURCE_ID="qimanhwa"`, `PRIMARY_HOST="qimanhwa.com"`,
`API_BASE="https://api.qimanhwa.com/api/v1"`. `matchHost` strips `www.`.
`liveDomain()`→`PRIMARY_HOST`.

**Cloudflare handling — harvest then call API.** `api.qimanhwa.com` sits behind
Cloudflare. The adapter clears CF once via `BrowserPool` (headless on CI), which
seeds the per-host `cf_clearance` + matching UA into the `CookieJar`, then issues
the JSON API calls through `ctx.http.get` reusing that jar (the asurascans/drake
harvest pattern). Implementation note / first task: confirm whether `cf_clearance`
harvested on `qimanhwa.com` is accepted by `api.qimanhwa.com`; if the API host
challenges independently, harvest against `api.qimanhwa.com` directly, or fall
back to the ng-state path below.

**Parser (API-first):**
- **`resolveSeries(slug)`** — `GET {API_BASE}/series/<slug>`: title, cover,
  `coverReferer = "https://qimanhwa.com/"`. Slug parsed from the `/series/<slug>`
  URL.
- **`enumerateChapters`** — `GET {API_BASE}/series/<slug>/chapters`: map
  `data[]` → `ChapterStub` (number, title, `chapterUrl =
  https://qimanhwa.com/series/<slug>/<chapter.slug>`), **sorted ascending**.
  **Skip locked chapters** (`isFree === false` / `requiresPurchase === true`) and
  log how many were skipped (no silent truncation).
- **`parseChapterImages`** — `GET {API_BASE}/series/<slug>/chapters/<chapter-slug>`:
  map `images[].url` → `PageStub` (1-based `pageIndex`, `referer =
  imageRefererFor`). If the chapter turns out locked at fetch time, return empty +
  warn.
- **`imageRefererFor`** → `"https://qimanhwa.com/"` (media CDN expects the site
  origin as referer).
- **`fetchImage`** (optional) — if `media.qimanhwa.com` rejects the default client,
  route through the harvested context; otherwise omit and let `imageRunner` use the
  shared `HttpClient`.
- **`dismissNsfwSplash`** → no-op.

**Primary path (ng-state via render):** Per the implementation findings, the
`ng-state` TransferState blob is the most robust source and is promoted to the
primary parse path (the direct `api.qimanhwa.com` call is a documented future
optimization). A helper `extractNgState(html)` renders the page via
`ctx.browser.renderPage` (headless clears Cloudflare on CI), extracts
`<script id="ng-state" type="application/json">`, and `JSON.parse`s it **directly**
— the blob is plain JSON (Angular uses `\uXXXX` escapes that `JSON.parse` handles;
no entity-unescaping needed). It is a map of cached `{ u: <url>, b: <body> }`
entries; helpers locate the series/chapters/chapter bodies by matching the `u`
suffix and read the title/cover, chapter list, and `images[]` from them. The
chapter `images[]` carry `url` + `order`; sort by `order`. Image hosts vary
(`media.quantumscans.org`, `media.qimanhwa.com`) and are used verbatim.

**Tests:** capture real API JSON (`series`, `chapters`, one `chapter`) and a real
page (for the ng-state helper) into `test/fixtures/qimanhwa/`; unit-test the JSON
mappers (chapter list + ascending sort + **paywall skipping**, image extraction)
and `extractNgState`. The probe artifacts (`qimanhwa-real-dom-capture`,
`qimanhwa-api-json`) are the source for these fixtures.

---

## Piece 4 — GitHub-Actions execution workflow

A workflow that runs the actual scraper CLI on a GitHub runner (this is how
qimanhwa — and optionally any CF-gated source — is run in practice).

**File:** `.github/workflows/scrape.yml`, `workflow_dispatch` with inputs:
`url` (series URL), `chapters` (range, e.g. `1-10` or `all`), and optional
`source` override.

**Steps:** checkout → `setup-node@v4` (Node 20) → `npm ci && npm run build` →
`npx playwright install --with-deps chromium` → run the CLI **headless** against
the inputs → upload the output ZIP(s) as an artifact (`actions/upload-artifact`).

**Notes / constraints:**
- Headless is mandatory in CI (no display). The existing CF-gated adapters
  (asura/drake/hivetoons) currently assume a **headed** manual Turnstile solve
  (`--allow-headed-cloudflare`); the probe shows headless stealth *can* clear CF
  from datacenter IPs, but this must be verified per-source before relying on it in
  CI. Until verified, this workflow targets manhwanex + qimanhwa; the headed
  adapters keep their existing local workflow.
- Throttle/pace requests (the existing `Throttler`) to stay under Cloudflare's
  radar; the volume probe was clean at ~6 s/page, so keep comparable pacing.
- Output ZIPs leave via build artifacts (ephemeral runner storage).

---

## Cross-cutting: testing and docs

- All adapter/helper tests remain fixture-based; no test hits a live network.
- README updates:
  - "Supported sources" table: add manhwanex (✅) and qimanhwa (✅ via GitHub
    Actions; ❌ from the Zscaler-filtered corporate network).
  - "Corporate networks (Zscaler)" section: document that qimanhwa is blocked
    locally by Katim AUP ("Online and Other Games") and is scraped via the GitHub
    Actions workflow instead.
- Keep the diagnostic `qimanhwa-probe.yml` workflow (already committed) for future
  re-verification of Cloudflare posture.

## Out of scope
- The SOCKS5 / per-host egress-bypass transport and its dependencies (dropped).
- Authenticated/paid-chapter access on qimanhwa (locked chapters are skipped).
- Converting the existing headed CF adapters to headless CI (verify-then-migrate
  later; not part of this spec).
- Changes to the other five adapters.
