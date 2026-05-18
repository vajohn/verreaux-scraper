// ---------------------------------------------------------------------------
// CfHandler — §7 Cloudflare challenge handler state machine
//
// State identifiers (verbatim from §7.2):
//   CF_DETECT → CF_CHECK_JAR
//   CF_CHECK_JAR → CF_REUSE_CLEARANCE | CF_LAUNCH_BROWSER
//   CF_REUSE_CLEARANCE → CF_RETRY_ORIGINAL
//   CF_RETRY_ORIGINAL → CF_CLEARED | CF_LAUNCH_BROWSER (stale)
//   CF_LAUNCH_BROWSER → CF_HARVEST_COOKIES | CF_TURNSTILE_DETECTED | CF_ESCALATE_FLARESOLVERR
//   CF_TURNSTILE_DETECTED → CF_HUMAN_PROMPT (--headful+TTY) | CF_ESCALATE_FLARESOLVERR
//   CF_HUMAN_PROMPT → CF_HARVEST_COOKIES | CF_FAIL (timeout)
//   CF_HARVEST_COOKIES → CF_RETRY_ORIGINAL
//   CF_ESCALATE_FLARESOLVERR → CF_HARVEST_COOKIES | CF_FAIL
//   CF_CLEARED → done
//   CF_NOOP → done (false positive)
//   CF_FAIL → throw CfUnsolvableError (exit 3)
//
// Implementation rules:
//   - ALL state entries emit cf.state.entered with the state name
//   - throttler.withCfMutex(host) wraps the entire resolve — one CF solve per host
//   - RETRY_ORIGINAL uses the same UA bound to the new cookie
//   - Max one retry of original request after STORE_COOKIES
//   - Abort signal closes browser context and emits cf.aborted / throws AbortError
//   - Human-intervention mode: headless:false, console prompt (stdin)
// ---------------------------------------------------------------------------

import * as readline from "node:readline";
import type { CookieJar } from "./cookies.js";
import type { BrowserPool, HarvestResult } from "./browser.js";
import { AbortError } from "./browser.js";
import type { FlareSolverrClient } from "./flaresolverr.js";
import type { Throttler } from "./throttle.js";
import type { HttpClient } from "./http.js";
import type { EventBus, ScraperEvent } from "../core/events.js";
import type { CookieRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// CF state names — §7 identifiers
// ---------------------------------------------------------------------------
export type CfState =
  | "CF_DETECT"
  | "CF_NOOP"
  | "CF_CHECK_JAR"
  | "CF_REUSE_CLEARANCE"
  | "CF_RETRY_ORIGINAL"
  | "CF_CLEARED"
  | "CF_LAUNCH_BROWSER"
  | "CF_TURNSTILE_DETECTED"
  | "CF_HUMAN_PROMPT"
  | "CF_HARVEST_COOKIES"
  | "CF_ESCALATE_FLARESOLVERR"
  | "CF_FAIL";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CfUnsolvableError extends Error {
  override readonly name = "CfUnsolvableError";
  readonly code: string;
  constructor(code = "ERR_CF_UNSOLVABLE") {
    super(`Cloudflare challenge could not be solved (${code})`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface CfRequest {
  url: string;
  method: "GET" | "POST";
  host: string;
  headers?: Record<string, string>;
  body?: string;
  reason?: "status_403" | "status_503" | "body_marker";
}

export interface CfResolveContext {
  http: HttpClient;
  browser: BrowserPool;
  jar: CookieJar;
  throttler: Throttler;
  flaresolverr: FlareSolverrClient | null;
  /** If true, launch browser with headless:false and prompt user to solve Turnstile */
  allowHeaded: boolean;
  eventBus: EventBus;
}

export interface CfSuccess {
  ok: true;
  userAgent: string;
  responseBody: string | Buffer;
  responseStatus: number;
}

export interface CfFailure {
  ok: false;
  code: string;
  retryable: false;
}

// ---------------------------------------------------------------------------
// CfHandler
// ---------------------------------------------------------------------------

export class CfHandler {
  // ---------------------------------------------------------------------------
  // resolve — public entry point
  // Wraps the entire solve in withCfMutex so at most one browser runs per host.
  // ---------------------------------------------------------------------------
  async resolve(
    req: CfRequest,
    ctx: CfResolveContext,
  ): Promise<CfSuccess> {
    return ctx.throttler.withCfMutex(req.host, () => this.runStateMachine(req, ctx));
  }

  // ---------------------------------------------------------------------------
  // runStateMachine — drives the §7 state diagram
  // ---------------------------------------------------------------------------
  private async runStateMachine(
    req: CfRequest,
    ctx: CfResolveContext,
  ): Promise<CfSuccess> {
    const { eventBus, jar } = ctx;
    const abortController = new AbortController();

    // CF_DETECT — already confirmed by caller (status 403/503 with CF signature)
    this.enterState(eventBus, "CF_DETECT");
    eventBus.emit("cf.detected", {
      host: req.host,
      reason: req.reason ?? "status_403",
      status: req.reason === "status_503" ? 503 : 403,
    });

    // CF_CHECK_JAR
    this.enterState(eventBus, "CF_CHECK_JAR");
    await jar.loadForDomain(req.host);
    const hasFresh = jar.hasFreshCfClearance(req.host);
    const ageMs = jar.getFreshCfClearanceAge(req.host);
    eventBus.emit("cf.jar_checked", { host: req.host, hit: hasFresh });

    if (hasFresh) {
      // CF_REUSE_CLEARANCE
      this.enterState(eventBus, "CF_REUSE_CLEARANCE");
      const boundUa = jar.getUaForCfClearance(req.host);
      const ua = boundUa ?? "Mozilla/5.0";
      eventBus.emit("cf.reuse", { host: req.host, ageMs: ageMs ?? 0 });

      // CF_RETRY_ORIGINAL with cached cookie
      const retryResult = await this.retryOriginal(req, ctx, ua, abortController.signal);
      if (retryResult.ok) {
        return retryResult.result;
      }
      // Still blocked — fall through to CF_LAUNCH_BROWSER
      // Mark the stale jar entry (clear it so next time we re-harvest)
      jar.clearDomain(req.host);
    }

    // CF_LAUNCH_BROWSER
    return this.launchBrowser(req, ctx, abortController);
  }

  // ---------------------------------------------------------------------------
  // launchBrowser — CF_LAUNCH_BROWSER state
  // ---------------------------------------------------------------------------
  private async launchBrowser(
    req: CfRequest,
    ctx: CfResolveContext,
    abortController: AbortController,
  ): Promise<CfSuccess> {
    const { eventBus, browser, jar } = ctx;
    this.enterState(eventBus, "CF_LAUNCH_BROWSER");
    eventBus.emit("cf.browser_launch", { host: req.host, headful: false });

    let harvestResult: HarvestResult | null = null;
    let isTurnstile = false;

    try {
      // Try to harvest clearance. harvestClearance internally navigates and
      // waits for cf_clearance. If the page has a Turnstile widget, navigation
      // will not fully complete (challenge form stays visible).
      harvestResult = await this.tryHarvestWithTurnstileDetection(
        req,
        ctx,
        abortController.signal,
      );
    } catch (err) {
      if (err instanceof AbortError) {
        eventBus.emit("cf.fail", { host: req.host, code: "ERR_CF_ABORTED" });
        throw new CfUnsolvableError("ERR_CF_ABORTED");
      }
      // Check if this was a Turnstile detection
      if (err instanceof TurnstileDetectedError) {
        isTurnstile = true;
      } else {
        // Browser failed silently → CF_ESCALATE_FLARESOLVERR
        return this.escalateFlaresolverr(req, ctx, abortController);
      }
    }

    if (isTurnstile) {
      // CF_TURNSTILE_DETECTED
      this.enterState(eventBus, "CF_TURNSTILE_DETECTED");
      eventBus.emit("cf.turnstile", { host: req.host });

      if (ctx.allowHeaded) {
        // CF_HUMAN_PROMPT
        harvestResult = await this.humanPrompt(req, ctx, abortController);
      } else {
        // Non-interactive → CF_ESCALATE_FLARESOLVERR
        return this.escalateFlaresolverr(req, ctx, abortController);
      }
    }

    if (!harvestResult) {
      return this.escalateFlaresolverr(req, ctx, abortController);
    }

    // CF_HARVEST_COOKIES
    return this.harvestCookies(req, ctx, harvestResult, abortController);
  }

  // ---------------------------------------------------------------------------
  // tryHarvestWithTurnstileDetection — attempts browser harvest and distinguishes
  // Turnstile-blocked from other failures.
  // ---------------------------------------------------------------------------
  private async tryHarvestWithTurnstileDetection(
    req: CfRequest,
    ctx: CfResolveContext,
    abortSignal: AbortSignal,
  ): Promise<HarvestResult> {
    // We use the browser to navigate; if we detect a Turnstile iframe before
    // cf_clearance appears, throw TurnstileDetectedError.
    const { browser, jar, eventBus } = ctx;

    // We need a way to distinguish Turnstile from generic failure.
    // Strategy: start a page navigation, poll for Turnstile selector,
    // and if detected, abort harvest and throw TurnstileDetectedError.
    //
    // Since harvestClearance will throw if no cf_clearance is found,
    // we use solveTurnstile for the Turnstile path and catch the error
    // from harvestClearance to check if it's a Turnstile case.
    //
    // Implementation: attempt harvestClearance first; if it fails with
    // the "no clearance" message, separately check if the browser page
    // has a Turnstile widget by re-navigating. For simplicity, we
    // wrap this in a race: harvestClearance vs. a Turnstile check.
    try {
      return await browser.harvestClearance(req.host, req.url, abortSignal);
    } catch (err) {
      if (err instanceof AbortError) throw err;

      // Try to detect Turnstile by checking if CF page has the widget
      // via a separate lightweight check.
      const hasTurnstile = await this.checkForTurnstile(
        req.host,
        req.url,
        ctx,
        abortSignal,
      );
      if (hasTurnstile) {
        throw new TurnstileDetectedError();
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // checkForTurnstile — quick DOM check for Turnstile iframe
  // ---------------------------------------------------------------------------
  private async checkForTurnstile(
    host: string,
    url: string,
    ctx: CfResolveContext,
    _abortSignal: AbortSignal,
  ): Promise<boolean> {
    // Use got to fetch the page and check for Turnstile markers in HTML.
    // This is cheap — no browser needed for detection.
    try {
      const resp = await ctx.http.get(url, {});
      const body = resp.body;
      return /challenges\.cloudflare\.com|cf-turnstile|class="cf-turnstile"/i.test(body);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // humanPrompt — CF_HUMAN_PROMPT state
  // ---------------------------------------------------------------------------
  private async humanPrompt(
    req: CfRequest,
    ctx: CfResolveContext,
    abortController: AbortController,
  ): Promise<HarvestResult> {
    const { eventBus, browser } = ctx;
    const TIMEOUT_SEC = 300; // 5 min

    this.enterState(eventBus, "CF_HUMAN_PROMPT");
    eventBus.emit("cf.human_prompt", { host: req.host, timeoutSec: TIMEOUT_SEC });

    // Print to stderr so it's visible even when piped
    process.stderr.write(
      `\n[verreaux] Cloudflare Turnstile detected for ${req.host}.\n` +
        `Solve the puzzle in the browser window. Press ENTER when done (${TIMEOUT_SEC}s timeout).\n`,
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    const userConfirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        rl.close();
        resolve(false);
      }, TIMEOUT_SEC * 1000);

      rl.once("line", () => {
        clearTimeout(timer);
        rl.close();
        resolve(true);
      });

      rl.once("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (!userConfirmed) {
      this.enterState(eventBus, "CF_FAIL");
      eventBus.emit("cf.fail", { host: req.host, code: "ERR_TURNSTILE_TIMEOUT" });
      throw new CfUnsolvableError("ERR_TURNSTILE_TIMEOUT");
    }

    // After user confirmation, harvest cookies from the browser
    const { abortSignal } = { abortSignal: abortController.signal };
    return browser.harvestClearance(req.host, req.url, abortSignal);
  }

  // ---------------------------------------------------------------------------
  // harvestCookies — CF_HARVEST_COOKIES state
  // Persist cookies to the jar, then proceed to CF_RETRY_ORIGINAL.
  // ---------------------------------------------------------------------------
  private async harvestCookies(
    req: CfRequest,
    ctx: CfResolveContext,
    harvest: HarvestResult,
    abortController: AbortController,
  ): Promise<CfSuccess> {
    const { eventBus, jar } = ctx;
    this.enterState(eventBus, "CF_HARVEST_COOKIES");

    // Persist all harvested cookies with UA binding
    for (const cookie of harvest.cookies) {
      jar.set({ ...cookie, userAgent: harvest.userAgent });
    }

    eventBus.emit("cf.harvested", {
      host: req.host,
      cookieNames: harvest.cookies.map((c) => c.name),
    });

    // CF_RETRY_ORIGINAL
    const retryResult = await this.retryOriginal(
      req,
      ctx,
      harvest.userAgent,
      abortController.signal,
    );

    if (retryResult.ok) {
      return retryResult.result;
    }

    // Retry also challenged — do NOT loop. Fail.
    this.enterState(eventBus, "CF_FAIL");
    eventBus.emit("cf.fail", { host: req.host, code: "ERR_CF_RETRY_STILL_BLOCKED" });
    throw new CfUnsolvableError("ERR_CF_RETRY_STILL_BLOCKED");
  }

  // ---------------------------------------------------------------------------
  // escalateFlaresolverr — CF_ESCALATE_FLARESOLVERR state
  // ---------------------------------------------------------------------------
  private async escalateFlaresolverr(
    req: CfRequest,
    ctx: CfResolveContext,
    abortController: AbortController,
  ): Promise<CfSuccess> {
    const { eventBus, flaresolverr, jar } = ctx;
    this.enterState(eventBus, "CF_ESCALATE_FLARESOLVERR");

    if (!flaresolverr) {
      return this.handleFlareSolverrUnavailable(req, ctx);
    }

    const isReachable = await flaresolverr.isReachable();
    if (!isReachable) {
      return this.handleFlareSolverrUnavailable(req, ctx);
    }

    eventBus.emit("cf.fs_call", { url: req.url });

    let fsResult: { cookies: Array<CookieRecord & { host: string }>; userAgent: string };
    try {
      fsResult = await flaresolverr.solve(req.url, abortController.signal);
    } catch (err) {
      if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
        this.enterState(eventBus, "CF_FAIL");
        eventBus.emit("cf.fail", { host: req.host, code: "ERR_CF_ABORTED" });
        throw new CfUnsolvableError("ERR_CF_ABORTED");
      }
      const reason = err instanceof Error ? err.message : String(err);
      eventBus.emit("cf.fs_fail", { url: req.url, reason });
      // FS failed → CF_FAIL (no headed option in this path)
      return this.handleFsFailed(req, ctx);
    }

    eventBus.emit("cf.fs_ok", { url: req.url });

    // CF_HARVEST_COOKIES — persist FS result
    return this.harvestCookies(req, ctx, fsResult, abortController);
  }

  // ---------------------------------------------------------------------------
  // handleFlareSolverrUnavailable — FS not reachable
  // ---------------------------------------------------------------------------
  private handleFlareSolverrUnavailable(
    req: CfRequest,
    ctx: CfResolveContext,
  ): never {
    const { eventBus } = ctx;
    this.enterState(eventBus, "CF_FAIL");
    eventBus.emit("cf.fail", { host: req.host, code: "ERR_FS_UNAVAILABLE" });
    throw new CfUnsolvableError("ERR_FS_UNAVAILABLE");
  }

  // ---------------------------------------------------------------------------
  // handleFsFailed — FS call failed
  // ---------------------------------------------------------------------------
  private handleFsFailed(
    req: CfRequest,
    ctx: CfResolveContext,
  ): never {
    const { eventBus } = ctx;
    this.enterState(eventBus, "CF_FAIL");
    eventBus.emit("cf.fail", { host: req.host, code: "ERR_FS_FAILED" });
    throw new CfUnsolvableError("ERR_FS_FAILED");
  }

  // ---------------------------------------------------------------------------
  // retryOriginal — CF_RETRY_ORIGINAL state
  // Re-issues the original failing request with the bound UA + fresh cookies.
  // ---------------------------------------------------------------------------
  private async retryOriginal(
    req: CfRequest,
    ctx: CfResolveContext,
    ua: string,
    abortSignal: AbortSignal,
  ): Promise<
    | { ok: true; result: CfSuccess }
    | { ok: false }
  > {
    const { eventBus, http, jar } = ctx;
    this.enterState(eventBus, "CF_RETRY_ORIGINAL");

    // Reload fresh cookies for the domain before retry
    await jar.loadForDomain(req.host);
    const cookieHeader = await jar.serializeForHost(req.host, ua);

    eventBus.emit("cf.retry", { url: req.url, status: 0 });

    let resp: import("got").Response<string>;

    try {
      if (req.method === "GET") {
        resp = await http.get(req.url, {
          headers: {
            ...(req.headers ?? {}),
            "user-agent": ua,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          signal: abortSignal,
        });
      } else {
        resp = await http.post(req.url, {
          headers: {
            ...(req.headers ?? {}),
            "user-agent": ua,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          body: req.body,
          signal: abortSignal,
        });
      }
    } catch (err) {
      if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
        throw new AbortError();
      }
      return { ok: false };
    }

    const status = resp.statusCode;
    eventBus.emit("cf.retry", { url: req.url, status });

    // Check for CF challenge in retry response
    const isCfChallenge = http.isCloudflareChallenged(resp);
    if (isCfChallenge || status === 403 || status === 503) {
      return { ok: false };
    }

    // CF_CLEARED
    this.enterState(eventBus, "CF_CLEARED");
    eventBus.emit("cf.cleared", { host: req.host });

    const body: string = resp.body;

    return {
      ok: true,
      result: {
        ok: true,
        userAgent: ua,
        responseBody: body,
        responseStatus: status,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // enterState — emits cf.state.entered for every state transition.
  // Every state entry calls this first (§7 spec + test requirement).
  // ---------------------------------------------------------------------------
  private enterState(eventBus: EventBus, state: CfState): void {
    eventBus.emit("cf.state.entered", { state });
  }
}

// ---------------------------------------------------------------------------
// Internal sentinel for Turnstile detection
// ---------------------------------------------------------------------------
class TurnstileDetectedError extends Error {
  override readonly name = "TurnstileDetectedError";
  constructor() {
    super("Cloudflare Turnstile widget detected");
  }
}
