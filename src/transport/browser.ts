// ---------------------------------------------------------------------------
// BrowserPool — lazy-init Playwright chromium with playwright-extra + stealth
//
// Per-spec requirements:
//   - One persistent context per host (cookies stay isolated per site)
//   - harvestClearance: navigate, wait up to 45s for cf_clearance, return
//     cookies + UA
//   - solveTurnstile: same but 120s timeout, watches for Turnstile token
//   - Headless by default; headless:false opt-in for human-intervention mode
//   - Stealth plugin: stealth FIRST, then chromium.use(stealth)
//   - Abort signal: closes context on cancellation, emits cf.aborted
// ---------------------------------------------------------------------------

import { addExtra } from "playwright-extra";
import { chromium as playwrightChromium } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import type { CookieRecord } from "../core/types.js";
import type { EventBus } from "../core/events.js";

// ---------------------------------------------------------------------------
// Realistic UA pool — rotated to avoid fingerprinting on repeated solves
// ---------------------------------------------------------------------------
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

function pickUA(): string {
  const idx = Math.floor(Math.random() * UA_POOL.length);
  return UA_POOL[idx] ?? UA_POOL[0]!;
}

export interface HarvestResult {
  cookies: Array<CookieRecord & { host: string }>;
  userAgent: string;
}

export class AbortError extends Error {
  override readonly name = "AbortError";
  constructor(message = "Operation aborted") {
    super(message);
  }
}

export class BrowserPool {
  // Stealth-wrapped playwright instance — built once
  private playwrightExtra = addExtra(playwrightChromium);
  private browser: Browser | null = null;
  // One context per host
  private readonly contexts = new Map<string, BrowserContext>();
  // Hosts we've already announced an opened headed window for — keeps the
  // stderr prompt limited to once per host per run.
  private readonly announcedHeadedHosts = new Set<string>();
  private initiated = false;

  constructor(
    private readonly eventBus: EventBus,
    private readonly headless: boolean = true,
  ) {
    // Stealth FIRST per spec
    this.playwrightExtra.use(StealthPlugin());
  }

  /** Print a one-time, user-visible notice when a headed browser opens, so the
   *  human knows a Cloudflare/Turnstile widget is awaiting interaction. */
  private announceHeadedOpen(host: string, url: string): void {
    if (this.headless) return;
    if (this.announcedHeadedHosts.has(host)) return;
    this.announcedHeadedHosts.add(host);
    const line =
      `\n` +
      `============================================================\n` +
      ` ACTION REQUIRED: a browser window is opening for ${host}.\n` +
      `\n` +
      `   1. If Cloudflare shows "Verify you are human", CLICK it.\n` +
      `   2. WAIT for the page to load (do NOT close the window).\n` +
      `   3. The scraper continues automatically once cleared.\n` +
      `\n` +
      ` URL: ${url}\n` +
      `============================================================\n\n`;
    process.stderr.write(line);
  }

  // ---------------------------------------------------------------------------
  // harvestClearance — navigate to challengeUrl, wait up to 45s for cf_clearance.
  // ---------------------------------------------------------------------------
  async harvestClearance(
    host: string,
    challengeUrl: string,
    abortSignal: AbortSignal,
  ): Promise<HarvestResult> {
    const ua = pickUA();
    this.eventBus.emit("cf.browser_launch", { host, headful: !this.headless });
    this.announceHeadedOpen(host, challengeUrl);

    const { context, page } = await this.getContextAndPage(host, ua, abortSignal);

    try {
      await this.navigatePastChallenge(page, challengeUrl, 45_000, abortSignal);

      const rawCookies = await context.cookies();
      const cookies = rawCookies
        .filter((c) => c.domain.includes(host) || host.includes(c.domain.replace(/^\./, "")))
        .map((c) => this.playwrightCookieToRecord(c, ua));

      const cfClearance = cookies.find((c) => c.name === "cf_clearance");
      if (!cfClearance) {
        this.eventBus.emit("cf.fail", { host, code: "ERR_CF_HARVEST_NO_CLEARANCE" });
        throw new Error(`No cf_clearance cookie harvested for ${host}`);
      }

      this.eventBus.emit("cf.harvested", {
        host,
        cookieNames: cookies.map((c) => c.name),
      });

      return { cookies, userAgent: ua };
    } catch (err) {
      if (abortSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.eventBus.emit("cf.fail", { host, code: "ERR_CF_ABORTED" });
        await this.closeContext(host);
        throw new AbortError();
      }
      this.eventBus.emit("cf.fail", { host, code: "ERR_CF_HARVEST_FAILED" });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // solveTurnstile — 120s timeout, watches for Turnstile token presence.
  // ---------------------------------------------------------------------------
  async solveTurnstile(
    host: string,
    challengeUrl: string,
    abortSignal: AbortSignal,
  ): Promise<HarvestResult> {
    const ua = pickUA();
    this.eventBus.emit("cf.browser_launch", { host, headful: !this.headless });
    this.eventBus.emit("cf.turnstile", { host });
    this.announceHeadedOpen(host, challengeUrl);

    const { context, page } = await this.getContextAndPage(host, ua, abortSignal);

    try {
      // Navigate to the challenge URL
      await page.goto(challengeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Wait for Turnstile token (cf-turnstile-response input) or cf_clearance cookie
      await this.waitForTurnstileOrClearance(page, 120_000, abortSignal);

      const rawCookies = await context.cookies();
      const cookies = rawCookies
        .filter((c) => c.domain.includes(host) || host.includes(c.domain.replace(/^\./, "")))
        .map((c) => this.playwrightCookieToRecord(c, ua));

      const cfClearance = cookies.find((c) => c.name === "cf_clearance");
      if (!cfClearance) {
        this.eventBus.emit("cf.fail", { host, code: "ERR_TURNSTILE_TIMEOUT" });
        throw new Error(`Turnstile solve timed out for ${host}`);
      }

      this.eventBus.emit("cf.harvested", {
        host,
        cookieNames: cookies.map((c) => c.name),
      });

      return { cookies, userAgent: ua };
    } catch (err) {
      if (abortSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
        this.eventBus.emit("cf.fail", { host, code: "ERR_CF_ABORTED" });
        await this.closeContext(host);
        throw new AbortError();
      }
      this.eventBus.emit("cf.fail", { host, code: "ERR_TURNSTILE_FAILED" });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // renderPage — navigate to url, wait for selector (or networkidle), return
  // fully hydrated HTML.  Reuses the per-host persistent context so cookies
  // and the UA stay aligned with any previously harvested cf_clearance.
  // ---------------------------------------------------------------------------
  // renderPage — navigate to url, wait for selector (or networkidle), return
  // fully hydrated HTML.  Reuses the per-host persistent context so cookies
  // and the UA stay aligned with any previously harvested cf_clearance.
  //
  // opts.state: Playwright waitForSelector state.
  //   Default: 'attached' — the element is in the DOM regardless of visibility.
  //   Pass 'visible' only when you need the element to be in the viewport.
  //   NOTE: 'visible' is WRONG for script tags and off-screen elements and will
  //   always time out; 'attached' is the safe default.
  // ---------------------------------------------------------------------------
  async renderPage(
    url: string,
    opts: {
      waitForSelector?: string;
      /** Playwright waitForSelector state.  Default: 'attached'. */
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
    } = {},
  ): Promise<string> {
    const host = new URL(url).hostname;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const waitState = opts.state ?? "attached";
    const abortSignal = AbortSignal.timeout(timeoutMs + 5_000);

    const browser = await this.ensureBrowser();

    let context = this.contexts.get(host);
    if (!context) {
      const ua = pickUA();
      context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      this.contexts.set(host, context);
    }

    this.announceHeadedOpen(host, url);

    // Attempt up to twice — Cloudflare interstitials sometimes detach the
    // initial frame during their post-challenge redirect cascade, which
    // surfaces as "Target page, context or browser has been closed".
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

        if (opts.waitForSelector) {
          await page.waitForSelector(opts.waitForSelector, {
            state: waitState,
            timeout: timeoutMs,
          });
        } else {
          await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {
            // networkidle may time out on pages with persistent connections — that
            // is fine; the DOM is ready enough after domcontentloaded + a brief wait.
          });
        }

        const html = await page.content();

        this.eventBus.emit("transport.browser.rendered" as never, {
          url,
          host,
        } as never);

        return html;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTargetClosed = msg.includes("Target") && msg.includes("closed");
        if (!isTargetClosed || attempt >= 1) {
          if (isTargetClosed) {
            throw new Error(
              `Browser window was closed before the page finished loading. ` +
                `If Cloudflare's "Verify you are human" widget appeared, click it and ` +
                `leave the window open until the page loads. Re-run the command and ` +
                `complete the challenge without closing the window. (Underlying: ${msg})`,
            );
          }
          throw err;
        }
        // Retry after a short delay; the persistent context keeps any cookies
        // we may have already harvested from the failed attempt.
        await new Promise((r) => setTimeout(r, 1_500));
      } finally {
        await page.close().catch(() => {});
      }
    }

    // Suppress unused-variable lint warning — abortSignal is bound above
    void abortSignal;
    throw lastErr ?? new Error("renderPage failed");
  }

  // ---------------------------------------------------------------------------
  // runInPage — navigate to `url`, then evaluate `fn` inside the page so it
  // can issue `fetch()` calls against the site's own API surface. Useful for
  // SPAs that compute short-lived auth tokens client-side and reject curl-style
  // requests.
  //
  // The returned value must be JSON-serialisable (Playwright's evaluate boundary).
  // ---------------------------------------------------------------------------
  async runInPage<T, A = undefined>(
    url: string,
    fn: (arg: A) => Promise<T> | T,
    opts: {
      timeoutMs?: number;
      waitForSelector?: string;
      /** Playwright waitForSelector state. Default 'attached'. */
      state?: "attached" | "detached" | "visible" | "hidden";
      /** JSON-serialisable value forwarded as the sole argument to `fn`
       *  inside the page. Required when `fn` references outer-scope data,
       *  because Playwright serialises the function body and loses its
       *  closure. */
      arg?: A;
    } = {},
  ): Promise<T> {
    const host = new URL(url).hostname;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const waitState = opts.state ?? "attached";

    const browser = await this.ensureBrowser();

    let context = this.contexts.get(host);
    if (!context) {
      const ua = pickUA();
      context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      this.contexts.set(host, context);
    }

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, {
          state: waitState,
          timeout: timeoutMs,
        });
      } else {
        await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {
          // networkidle is best-effort
        });
      }

      // Cast through `unknown` — Playwright's PageFunction type uses Unboxed<A>
      // which the generic A here cannot satisfy without coercion.
      const result = await page.evaluate(
        fn as unknown as (a: unknown) => Promise<T> | T,
        opts.arg as unknown,
      );

      this.eventBus.emit("transport.browser.rendered" as never, {
        url,
        host,
      } as never);

      return result as T;
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // withPage — open a Page in the per-host context, hand it to `fn`, then
  // close it on exit (success or failure). Unlike `renderPage` / `runInPage`,
  // this primitive does NOT navigate or wait for any load state — that gives
  // the caller room to attach request/response listeners BEFORE navigation,
  // which is required for SPAs that compute per-request auth tokens
  // client-side (the token must be captured from the first SPA-issued request,
  // not synthesized in our code).
  //
  // `url` is used only to pick the per-host context. The caller is responsible
  // for calling `page.goto(...)` themselves.
  // ---------------------------------------------------------------------------
  async withPage<T>(
    url: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const host = new URL(url).hostname;
    const browser = await this.ensureBrowser();

    let context = this.contexts.get(host);
    if (!context) {
      const ua = pickUA();
      context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      this.contexts.set(host, context);
    }

    const page = await context.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // fetchBuffer — issue an HTTP GET through the per-host BrowserContext's
  // APIRequestContext.  This carries the context's cookies (including any
  // cf_clearance/session cookies populated by prior renderPage/withPage calls)
  // and the same User-Agent, so CDNs that gate on browser session state
  // hand back the real bytes instead of an anti-bot HTML challenge.
  // ---------------------------------------------------------------------------
  async fetchBuffer(
    url: string,
    opts: { referer?: string; timeoutMs?: number } = {},
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
  }> {
    const host = new URL(url).hostname;
    const browser = await this.ensureBrowser();

    let context = this.contexts.get(host);
    if (!context) {
      const ua = pickUA();
      context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      this.contexts.set(host, context);
    }

    const headers: Record<string, string> = {};
    if (opts.referer) headers["Referer"] = opts.referer;

    const resp = await context.request.get(url, {
      headers,
      timeout: opts.timeoutMs ?? 30_000,
      failOnStatusCode: false,
      maxRedirects: 5,
    });

    return {
      statusCode: resp.status(),
      headers: resp.headers(),
      body: await resp.body(),
    };
  }

  // ---------------------------------------------------------------------------
  // close — shuts all browser contexts and the browser itself.
  // ---------------------------------------------------------------------------
  async close(): Promise<void> {
    for (const [host, ctx] of this.contexts) {
      try { await ctx.close(); } catch { /* ignore */ }
      this.contexts.delete(host);
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    this.initiated = false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await this.playwrightExtra.launch({
        headless: this.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
        ],
      });
    }
    return this.browser;
  }

  private async getContextAndPage(
    host: string,
    ua: string,
    abortSignal: AbortSignal,
  ): Promise<{ context: BrowserContext; page: Page }> {
    if (abortSignal.aborted) throw new AbortError();

    const browser = await this.ensureBrowser();

    let context = this.contexts.get(host);
    if (!context) {
      context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });
      this.contexts.set(host, context);
    }

    const page = await context.newPage();
    return { context, page };
  }

  private async navigatePastChallenge(
    page: Page,
    url: string,
    timeoutMs: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new AbortError());
        return;
      }
      const onAbort = () => reject(new AbortError());
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });

    const navigationPromise = async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

      // Wait for CF challenge to clear: look for a page that no longer has
      // the challenge form. Timeout = timeoutMs total.
      await page.waitForFunction(
        // Passes when the body does NOT contain a challenge form
        () => {
          const challengeForm = document.querySelector("#challenge-form");
          const cfTitle =
            document.title.includes("Just a moment") ||
            document.title.includes("Checking your browser");
          return !challengeForm && !cfTitle;
        },
        { timeout: timeoutMs },
      );
    };

    await Promise.race([navigationPromise(), abortPromise]);
  }

  private async waitForTurnstileOrClearance(
    page: Page,
    timeoutMs: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(new AbortError());
        return;
      }
      const onAbort = () => reject(new AbortError());
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });

    const solvePromise = page.waitForFunction(
      () => {
        // Turnstile token present in input or in cookie
        const tokenInput = document.querySelector<HTMLInputElement>(
          "input[name='cf-turnstile-response']",
        );
        if (tokenInput && tokenInput.value) return true;

        // No challenge form left
        const challengeForm = document.querySelector("#challenge-form");
        const cfTitle =
          document.title.includes("Just a moment") ||
          document.title.includes("Checking your browser");
        return !challengeForm && !cfTitle;
      },
      { timeout: timeoutMs },
    );

    await Promise.race([solvePromise, abortPromise]);
  }

  private async closeContext(host: string): Promise<void> {
    const ctx = this.contexts.get(host);
    if (ctx) {
      try { await ctx.close(); } catch { /* ignore */ }
      this.contexts.delete(host);
    }
  }

  private playwrightCookieToRecord(
    c: {
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      secure: boolean;
      httpOnly: boolean;
      sameSite?: "Strict" | "Lax" | "None";
    },
    ua: string,
  ): CookieRecord & { host: string } {
    const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
    return {
      host,
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path,
      // Playwright gives -1 for session cookies
      expires: c.expires > 0 ? c.expires : null,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite ?? null,
      userAgent: ua,
      harvestedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
  }
}
