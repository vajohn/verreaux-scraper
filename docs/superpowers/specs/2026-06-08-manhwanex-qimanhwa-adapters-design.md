# Design: manhwanex + qimanhwa adapters and per-host egress-bypass

- **Date:** 2026-06-08
- **Status:** Approved (brainstorm complete; awaiting spec review before plan)
- **Scope:** One spec, four pieces. Pieces 1–3 are fully delivered. Piece 4 is a
  gated scaffold whose parser is intentionally blocked on a real capture.

---

## Background and findings

The scraper today has five working adapters (asurascans, manhuaplus, arenascan,
drake, hivetoons), all parsing server-rendered HTML or inline JSON literals and
all tested against captured fixtures. We want to add two new sources.

Both target hosts were probed from the corporate machine on 2026-06-08:

### manhwanex.com — reachable, Madara theme
- `GET https://manhwanex.com/` → `200 OK`, `Server: LiteSpeed`, `x-powered-by:
  PHP/8.3.31`. **No Cloudflare.**
- CMS markers: `wp-content/themes/madara`, `wp-manga`, `admin-ajax.php`,
  `<meta name="generator" content="WordPress 7.0">`. → **Madara WordPress theme.**
- A sample series page (`/manga/sss-grade-saint-knight/`) returns the **full
  chapter list in the static DOM** under `.wp-manga-chapter` /
  `listing-chapters_wrap` (real `/manga/<slug>/chapter-<n>` links present). Post
  id exposed as `data-id="454"`. Title under `.post-title h1`.
- TLS is intercepted by Zscaler (cert `O=Zscaler Inc.`, issuer `KATIM LLC /
  SMARTPROXY-UAE`), but the system keychain already trusts it, so the existing
  `src/cli/systemCa.ts` path handles it transparently. `SSL certificate verify
  ok` confirmed via curl.
- **Conclusion:** straightforward new adapter, simpler than drake (no browser/CF
  path). None of the five existing adapters are Madara-based, so the parser is
  net-new but textbook.

### qimanhwa.com — blocked + isolated, React/Vite SPA
- `GET https://qimanhwa.com/` over curl → `HTTP/1.1 403 Forbidden`,
  `Server: Zscaler/6.2`, a 15 497-byte "Internet Security by Zscaler" block page.
  The real origin DNS-resolves to Cloudflare (`104.26.x` / `172.67.x`).
- `WebFetch` (Anthropic egress) → `403`, i.e. qimanhwa's **Cloudflare** also
  blocks datacenter egress. So the host is unreachable from this session by every
  available path (curl→Zscaler 403, browser→CBI isolation, WebFetch→CF 403).
- The HTML the user captured (`/Users/JLAJ9408/Documents/Verreaux/qimanhwa/`,
  `series_page.html` + `chapter_page.html`) is **the Zscaler Cloud Browser
  Isolation (CBI) client**, not qimanhwa: the 602 KB `bundle.es.js` is the CBI
  app (17 `ISOLATION` refs, Bugsnag/SmartBear telemetry); `./js` carries CBI's
  `window.__env.themeSettings`. Zscaler *isolates* qimanhwa (renders it in a
  remote cloud browser and streams it back) rather than hard-blocking it for real
  browsers. The capture contains qimanhwa's `<title>` ("Ranker Who Lives a Second
  Life | Qi Manhwa") but **none** of its chapter list, image URLs, or API calls.
- qimanhwa itself is a **client-side React/Vite SPA** (hashed CSS-module
  classnames like `_nav-item_dxbxs_`, `bundle.es.js` ES module,
  `vite-legacy-polyfill`, `window.__env`). Content is hydrated at runtime from a
  JSON API. Static-HTML parsing — the technique all five existing adapters use —
  does not apply.
- **Conclusion:** the captured fixtures cannot produce a real parser, and
  qimanhwa needs (a) a genuine off-Zscaler egress and (b) a fresh capture taken
  through that egress before its parser can be written. Build the structure now,
  gate the parser.

### Decisions taken during brainstorm
- **Sequencing:** build manhwanex + the egress-bypass transport now; scaffold
  qimanhwa with the parser gated on a real capture.
- **Egress target:** a SOCKS5/HTTPS proxy the user controls (outside Zscaler).
  Design the transport around a per-host proxy URL.

---

## Piece 1 — `SourceAdapter` id union (shared)

Extend the closed union in `src/core/types.ts` (currently `"asurascans" |
"manhuaplus" | "arenascan" | "drake" | "hivetoons"`) to add `"manhwanex" |
"qimanhwa"`. Register both singletons in `src/adapters/index.ts`'s
`adapterRegistry` array. No other id-union references exist in `src/`.

---

## Piece 2 — manhwanex adapter (Madara) — fully delivered

**Files:** `src/adapters/manhwanex.ts`, `src/adapters/manhwanex.helpers.ts`,
`test/manhwanex.adapter.test.ts`, `test/manhwanex.helpers.test.ts`. Modeled on the
drake pair (helpers hold pure parsers; adapter orchestrates).

**Constants:** `SOURCE_ID = "manhwanex"`, `PRIMARY_HOST = "manhwanex.com"`,
`ORIGIN = "https://manhwanex.com"`. `matchHost` strips `www.` and compares to
`PRIMARY_HOST`. `domainAliases()` → `[]`. `liveDomain()` → `PRIMARY_HOST`.

**`resolveSeries(ctx, seriesUrl)`** — plain `ctx.http.get` (no browser):
- Parse title from `.post-title h1`, cover from `.summary_image img`
  (prefer `data-src`, fall back to `src`), referer = `ORIGIN + "/"`.
- Parse the server-rendered chapter list from `.wp-manga-chapter` /
  `listing-chapters_wrap` anchors → `RawChapter[]` (number + url), sorted
  ascending → `preEnumeratedChapters`.
- **Fallback only if the static list is empty:** `POST admin-ajax.php` with
  `action=manga_get_chapters` and the series `data-id` post id, then re-parse the
  returned HTML fragment with the same chapter parser.

**`enumerateChapters`** — return `preEnumeratedChapters` if present, else re-run
`resolveSeries`. (Same shape as drake.)

**`parseChapterImages(ctx, chapter, chapterHtml)`** — select `.reading-content
img`, prefer `data-src` over `src`, trim whitespace, keep DOM order, map to
`PageStub[]` with `pageIndex` 1-based and `referer = imageRefererFor(chapter)`.

**`imageRefererFor`** → `chapter.chapterUrl` (images served from
`manhwanex.com/wp-content/uploads/...`).

**`dismissNsfwSplash`** → no-op. If a Madara adult gate is later observed, set the
standard `wpmanga-adult` cookies; not implemented unless a gate appears in a real
fixture.

**No `fetchChapter`, no `fetchImage`, no proxy** — LiteSpeed serves plainly to
`got`; the default HttpClient path is sufficient.

**Tests:** capture a real series page + one chapter page into
`test/fixtures/manhwanex/` and unit-test helpers and the adapter against them,
mirroring the existing `drake.helpers.test.ts` and the `*.adapter.test.ts`
structure. Cover: title/cover extraction, chapter-list parsing + ascending sort,
the admin-ajax fallback path, and image extraction with `data-src` preference.

---

## Piece 3 — per-host egress-bypass (transport) — fully delivered

**New module `src/transport/proxy.ts`:**
- `resolveProxyForHost(host: string, config?: RunConfig): string | null` — returns
  a proxy URL for the host, or `null` for a direct connection.
- Sources, in precedence order: (1) `RunConfig.proxies` map (host → proxy URL),
  (2) environment variables of the form `SCRAPER_PROXY__<HOST_WITH_UNDERSCORES>`
  (e.g. `SCRAPER_PROXY__QIMANHWA_COM=socks5://user:pass@host:1080`). Host match is
  case-insensitive and `www.`-normalized. No match → `null` (direct).
- `buildProxyAgent(proxyUrl): { http: Agent; https: Agent }` — a small factory:
  `socks5://`/`socks://` → `SocksProxyAgent`; `http://`/`https://` →
  `HttpsProxyAgent`/`HttpProxyAgent`. Agents are cached per proxy URL.

**HttpClient (`src/transport/http.ts`):** in the per-request path (before
`this.instance.get(url, gotOpts)`), resolve the URL host; if a proxy is returned,
set `gotOpts.agent` to the built agents. Unmatched hosts keep the existing direct
behavior. The `got.extend` base config is unchanged; the agent is attached
per-request so only proxied hosts are affected.

**BrowserPool (`src/transport/browser.ts`):** when a per-host `BrowserContext` is
first created (the `newContext({...})` calls keyed by `host`), look up
`resolveProxyForHost(host)` and, if present, pass
`proxy: { server, username?, password? }` parsed from the proxy URL into
`newContext`. Parsed once per host alongside the existing UA/viewport config.

**Config schema:** add an optional `proxies?: Record<string, string>` to
`src/core/runConfigSchema.ts` (host → proxy URL). Optional so existing runs are
unaffected.

**New dependencies:** `socks-proxy-agent`, `https-proxy-agent` (the latter also
exports an http agent). Playwright needs no dependency — proxy support is native.

**Tests (`test/proxy.test.ts`):** `resolveProxyForHost` mapping and precedence
(config over env), `www.` normalization, no-match → `null`, and
`buildProxyAgent` scheme selection (socks vs http(s)). Live proxying is not
unit-tested (no proxy available in CI) and is documented as manual verification.

---

## Piece 4 — qimanhwa adapter — scaffold only, parser gated

**Files:** `src/adapters/qimanhwa.ts` (+ `qimanhwa.helpers.ts` if useful),
registered in the registry, `matchHost("qimanhwa.com")`, `liveDomain()` →
`"qimanhwa.com"`.

**Documented strategy (not yet implemented):** qimanhwa is a React/Vite SPA, so
`resolveSeries`/`parseChapterImages` will render the page via
`ctx.browser.renderPage` **through the per-host proxy** (reusing drake's
headed-Cloudflare + per-host-context pattern) and scrape the hydrated DOM. If a
later HAR capture reveals a clean JSON API, switch to an API-first implementation
as an optimization.

**Gate:** the parser methods throw a clear `QimanhwaNotYetImplementedError` that
references this spec and states the precondition: a real series + chapter capture
taken **through the off-Zscaler SOCKS5 egress**. The current
`/Users/JLAJ9408/Documents/Verreaux/qimanhwa/*.html` fixtures are Zscaler CBI
output and are explicitly rejected as a parser source. Selectors and fixtures are
TODO, blocked on that capture.

**Tests:** a registration/host-match test plus a test asserting the gated methods
throw the documented error. No parser tests until a real fixture exists.

---

## Cross-cutting: testing and docs

- All adapter/helper tests remain fixture-based, consistent with the repo's
  existing 207-test approach. New tests must not hit live networks.
- Update `README.md`:
  - "Supported sources" table: add manhwanex (✅ working) and qimanhwa
    (⚠️ requires off-Zscaler egress; parser pending real capture).
  - "Corporate networks (Zscaler / MITM proxies)" section: document the per-host
    proxy config (`RunConfig.proxies` and `SCRAPER_PROXY__<HOST>` env), and warn
    that on a managed device Zscaler Client Connector may still intercept a local
    proxy — in which case the only reliable egress is running the scraper on a
    remote host outside Zscaler.

## Out of scope
- Writing the real qimanhwa parser (blocked on a real capture).
- Any global/all-traffic proxy mode (per-host only, by decision).
- Reverse-engineering qimanhwa's JSON API (deferred; DOM-render first).
- Changes to the other five adapters.
