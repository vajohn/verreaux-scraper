// ---------------------------------------------------------------------------
// cf.test.ts — tests for the §7 CF challenge handler state machine
//
// Uses vi.mock to prevent actual Playwright / browser from launching.
// The BrowserPool, HttpClient, and FlareSolverrClient are all stubbed.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { openStore } from "../src/state/store.js";
import type { Store } from "../src/state/store.js";
import { CookieJar } from "../src/transport/cookies.js";
import { Throttler } from "../src/transport/throttle.js";
import { EventBus } from "../src/core/events.js";
import {
  CfHandler,
  CfUnsolvableError,
} from "../src/transport/cf.js";
import type { CfRequest, CfResolveContext } from "../src/transport/cf.js";
import type { CookieRecord } from "../src/core/types.js";
import { makeTmpDir } from "./setup.js";

// ---------------------------------------------------------------------------
// Mock playwright so no browser is launched in tests
// ---------------------------------------------------------------------------

vi.mock("playwright-extra", () => ({
  addExtra: vi.fn(() => ({
    use: vi.fn(),
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue(null),
          waitForFunction: vi.fn().mockResolvedValue(null),
        }),
        cookies: vi.fn().mockResolvedValue([]),
        close: vi.fn().mockResolvedValue(null),
      }),
      close: vi.fn().mockResolvedValue(null),
    }),
  })),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

vi.mock("puppeteer-extra-plugin-stealth", () => ({
  default: vi.fn(() => ({ name: "stealth" })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tracks every cf.state.entered event payload for assertion */
function collectStates(bus: EventBus): string[] {
  const states: string[] = [];
  bus.on((e) => {
    if (e.type === "cf.state.entered") {
      states.push((e.payload as { state: string }).state);
    }
  });
  return states;
}

function makeCfRequest(overrides: Partial<CfRequest> = {}): CfRequest {
  return {
    url: "https://asuracomic.net/series/test",
    method: "GET",
    host: "asuracomic.net",
    reason: "status_403",
    ...overrides,
  };
}

/** Build a minimal mock HttpClient */
function makeMockHttp(opts: {
  cfChallenge?: boolean;
  status?: number;
  body?: string;
} = {}) {
  return {
    get: vi.fn().mockResolvedValue({
      statusCode: opts.status ?? 200,
      body: opts.body ?? "<html>content</html>",
      headers: {},
    }),
    post: vi.fn().mockResolvedValue({
      statusCode: opts.status ?? 200,
      body: opts.body ?? "<html>content</html>",
      headers: {},
    }),
    isCloudflareChallenged: vi.fn().mockReturnValue(opts.cfChallenge ?? false),
  };
}

/** Build a minimal mock BrowserPool */
function makeMockBrowser(opts: {
  harvestResult?: { cookies: Array<CookieRecord & { host: string }>; userAgent: string };
  harvestError?: Error;
  turnstileResult?: { cookies: Array<CookieRecord & { host: string }>; userAgent: string };
} = {}) {
  const defaultCookies: Array<CookieRecord & { host: string }> = [
    {
      host: "asuracomic.net",
      domain: "asuracomic.net",
      name: "cf_clearance",
      value: "harvested-clearance",
      path: "/",
      expires: null,
      secure: true,
      httpOnly: false,
      sameSite: null,
      userAgent: "Mozilla/5.0 (Harvested-UA)",
      harvestedAt: new Date().toISOString(),
      lastUsedAt: null,
    },
  ];

  const harvestClearance = opts.harvestError
    ? vi.fn().mockRejectedValue(opts.harvestError)
    : vi.fn().mockResolvedValue(
        opts.harvestResult ?? { cookies: defaultCookies, userAgent: "Mozilla/5.0 (Harvested-UA)" },
      );

  const solveTurnstile = vi.fn().mockResolvedValue(
    opts.turnstileResult ?? { cookies: defaultCookies, userAgent: "Mozilla/5.0 (Harvested-UA)" },
  );

  return { harvestClearance, solveTurnstile, close: vi.fn() };
}

/** Build a minimal mock FlareSolverrClient */
function makeMockFlaresolverr(opts: {
  reachable?: boolean;
  cookies?: Array<CookieRecord & { host: string }>;
  error?: Error;
} = {}) {
  const defaultCookies: Array<CookieRecord & { host: string }> = [
    {
      host: "asuracomic.net",
      domain: "asuracomic.net",
      name: "cf_clearance",
      value: "fs-clearance",
      path: "/",
      expires: null,
      secure: true,
      httpOnly: false,
      sameSite: null,
      userAgent: "Mozilla/5.0 (FS-UA)",
      harvestedAt: new Date().toISOString(),
      lastUsedAt: null,
    },
  ];

  const isReachable = vi.fn().mockResolvedValue(opts.reachable ?? true);
  const solve = opts.error
    ? vi.fn().mockRejectedValue(opts.error)
    : vi.fn().mockResolvedValue({
        cookies: opts.cookies ?? defaultCookies,
        userAgent: "Mozilla/5.0 (FS-UA)",
      });

  return { isReachable, solve };
}

// ---------------------------------------------------------------------------
// Main tests
// ---------------------------------------------------------------------------

describe("CfHandler state machine", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;
  let jar: CookieJar;
  let bus: EventBus;
  let throttler: Throttler;
  let handler: CfHandler;

  beforeEach(() => {
    const tmp = makeTmpDir();
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    store = openStore(join(dir, "state.sqlite"));
    jar = new CookieJar(store);
    bus = new EventBus();
    throttler = new Throttler(bus, 3);
    handler = new CfHandler();
  });

  // afterEach is intentionally omitted here — makeTmpDir registers global cleanup.

  // -------------------------------------------------------------------------
  // Scenario 1: Jar hit — fresh cf_clearance reused
  // Expected states: CF_DETECT → CF_CHECK_JAR → CF_REUSE_CLEARANCE →
  //                  CF_RETRY_ORIGINAL → CF_CLEARED
  // -------------------------------------------------------------------------

  describe("Scenario: fresh cf_clearance in jar (jar hit)", () => {
    it("follows the REUSE_CLEARANCE path and returns success", async () => {
      const states = collectStates(bus);

      // Pre-seed a fresh cf_clearance
      const ua = "Mozilla/5.0 (Cached-UA)";
      jar.set({
        host: "asuracomic.net",
        domain: "asuracomic.net",
        name: "cf_clearance",
        value: "fresh-clearance",
        path: "/",
        expires: null,
        secure: true,
        httpOnly: false,
        sameSite: null,
        userAgent: ua,
        harvestedAt: new Date().toISOString(),
        lastUsedAt: null,
      });

      const http = makeMockHttp({ status: 200, cfChallenge: false });
      const browser = makeMockBrowser();
      const flaresolverr = makeMockFlaresolverr();

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      const result = await handler.resolve(makeCfRequest(), ctx);

      expect(result.ok).toBe(true);

      // State sequence assertions
      expect(states).toContain("CF_DETECT");
      expect(states).toContain("CF_CHECK_JAR");
      expect(states).toContain("CF_REUSE_CLEARANCE");
      expect(states).toContain("CF_RETRY_ORIGINAL");
      expect(states).toContain("CF_CLEARED");

      // Browser must NOT have been invoked (we reused the jar)
      expect(browser.harvestClearance).not.toHaveBeenCalled();

      // State order: CHECK_JAR before REUSE_CLEARANCE before RETRY_ORIGINAL before CLEARED
      const idxCheck = states.indexOf("CF_CHECK_JAR");
      const idxReuse = states.indexOf("CF_REUSE_CLEARANCE");
      const idxRetry = states.indexOf("CF_RETRY_ORIGINAL");
      const idxCleared = states.indexOf("CF_CLEARED");
      expect(idxCheck).toBeLessThan(idxReuse);
      expect(idxReuse).toBeLessThan(idxRetry);
      expect(idxRetry).toBeLessThan(idxCleared);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Jar miss → browser harvest succeeds
  // Expected states: CF_DETECT → CF_CHECK_JAR → CF_LAUNCH_BROWSER →
  //                  CF_HARVEST_COOKIES → CF_RETRY_ORIGINAL → CF_CLEARED
  // -------------------------------------------------------------------------

  describe("Scenario: jar miss, browser harvest succeeds", () => {
    it("follows the LAUNCH_BROWSER → HARVEST_COOKIES path", async () => {
      const states = collectStates(bus);

      // No cookie in jar — jar is empty
      const http = makeMockHttp({ status: 200, cfChallenge: false });
      const browser = makeMockBrowser();
      const flaresolverr = makeMockFlaresolverr();

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      const result = await handler.resolve(makeCfRequest(), ctx);
      expect(result.ok).toBe(true);

      expect(states).toContain("CF_DETECT");
      expect(states).toContain("CF_CHECK_JAR");
      expect(states).toContain("CF_LAUNCH_BROWSER");
      expect(states).toContain("CF_HARVEST_COOKIES");
      expect(states).toContain("CF_RETRY_ORIGINAL");
      expect(states).toContain("CF_CLEARED");

      // Browser was invoked
      expect(browser.harvestClearance).toHaveBeenCalledOnce();

      // State order
      const idxCheck = states.indexOf("CF_CHECK_JAR");
      const idxLaunch = states.indexOf("CF_LAUNCH_BROWSER");
      const idxHarvest = states.indexOf("CF_HARVEST_COOKIES");
      const idxRetry = states.indexOf("CF_RETRY_ORIGINAL");
      const idxCleared = states.indexOf("CF_CLEARED");
      expect(idxCheck).toBeLessThan(idxLaunch);
      expect(idxLaunch).toBeLessThan(idxHarvest);
      expect(idxHarvest).toBeLessThan(idxRetry);
      expect(idxRetry).toBeLessThan(idxCleared);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Browser fails → FlareSolverr succeeds
  // Expected states: CF_DETECT → CF_CHECK_JAR → CF_LAUNCH_BROWSER →
  //                  CF_ESCALATE_FLARESOLVERR → CF_HARVEST_COOKIES →
  //                  CF_RETRY_ORIGINAL → CF_CLEARED
  // -------------------------------------------------------------------------

  describe("Scenario: browser fails, FlareSolverr succeeds", () => {
    it("escalates to FlareSolverr and returns success", async () => {
      const states = collectStates(bus);

      // Browser fails (not Turnstile — generic failure)
      const browserError = new Error("Navigation timeout: challenge form still visible");
      const http = makeMockHttp({ status: 200, cfChallenge: false, body: "<html>no turnstile</html>" });
      const browser = makeMockBrowser({ harvestError: browserError });
      const flaresolverr = makeMockFlaresolverr({ reachable: true });

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      const result = await handler.resolve(makeCfRequest(), ctx);
      expect(result.ok).toBe(true);

      expect(states).toContain("CF_ESCALATE_FLARESOLVERR");
      expect(states).toContain("CF_HARVEST_COOKIES");
      expect(states).toContain("CF_CLEARED");

      // FS was called
      expect(flaresolverr.solve).toHaveBeenCalledOnce();

      // ESCALATE comes after LAUNCH_BROWSER
      const idxLaunch = states.indexOf("CF_LAUNCH_BROWSER");
      const idxEscalate = states.indexOf("CF_ESCALATE_FLARESOLVERR");
      expect(idxLaunch).toBeLessThan(idxEscalate);
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: All strategies fail, --headed not allowed → CfUnsolvableError
  // Expected states: CF_DETECT → CF_CHECK_JAR → CF_LAUNCH_BROWSER →
  //                  CF_ESCALATE_FLARESOLVERR → CF_FAIL
  // -------------------------------------------------------------------------

  describe("Scenario: all strategies fail, no headed mode → exit-code path", () => {
    it("throws CfUnsolvableError when browser fails, FS unreachable, allowHeaded=false", async () => {
      const states = collectStates(bus);

      const browserError = new Error("Browser harvest failed");
      const http = makeMockHttp({ status: 200, body: "<html>no turnstile</html>", cfChallenge: false });
      const browser = makeMockBrowser({ harvestError: browserError });
      // FS unreachable
      const flaresolverr = makeMockFlaresolverr({ reachable: false });

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      await expect(handler.resolve(makeCfRequest(), ctx)).rejects.toThrow(CfUnsolvableError);

      expect(states).toContain("CF_DETECT");
      expect(states).toContain("CF_CHECK_JAR");
      expect(states).toContain("CF_LAUNCH_BROWSER");
      expect(states).toContain("CF_ESCALATE_FLARESOLVERR");
      expect(states).toContain("CF_FAIL");

      // FS was probed for reachability
      expect(flaresolverr.isReachable).toHaveBeenCalledOnce();
      // solve should NOT have been called since FS is unreachable
      expect(flaresolverr.solve).not.toHaveBeenCalled();
    });

    it("CfUnsolvableError has code ERR_FS_UNAVAILABLE when FS unreachable", async () => {
      const browserError = new Error("harvest failed");
      const http = makeMockHttp({ status: 200, body: "<html>no turnstile</html>", cfChallenge: false });
      const browser = makeMockBrowser({ harvestError: browserError });
      const flaresolverr = makeMockFlaresolverr({ reachable: false });

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      let thrown: CfUnsolvableError | null = null;
      try {
        await handler.resolve(makeCfRequest(), ctx);
      } catch (err) {
        if (err instanceof CfUnsolvableError) thrown = err;
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.code).toBe("ERR_FS_UNAVAILABLE");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: null flaresolverr (disabled) → CF_FAIL immediately after browser
  // -------------------------------------------------------------------------

  describe("Scenario: FS explicitly null (disabled)", () => {
    it("fails with CF_FAIL when browser fails and FS is null", async () => {
      const states = collectStates(bus);

      const browserError = new Error("harvest failed");
      const http = makeMockHttp({ status: 200, body: "<html>no turnstile</html>", cfChallenge: false });
      const browser = makeMockBrowser({ harvestError: browserError });

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: null,
        allowHeaded: false,
        eventBus: bus,
      };

      await expect(handler.resolve(makeCfRequest(), ctx)).rejects.toThrow(CfUnsolvableError);
      expect(states).toContain("CF_FAIL");
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Retry-original also CF-challenged → fail without looping
  //
  // When the jar is empty, the machine goes through LAUNCH_BROWSER →
  // HARVEST_COOKIES → RETRY_ORIGINAL. If the retry is still CF-blocked,
  // the spec mandates: "Max one full retry of the original request after
  // STORE_COOKIES — if the retry also CF-challenges, fail with exit code 3
  // (do NOT loop)." We verify the state machine terminates with CF_FAIL
  // rather than cycling back through LAUNCH_BROWSER again.
  // -------------------------------------------------------------------------

  describe("Scenario: retry-original (post-STORE) also CF-challenged → no loop", () => {
    it("terminates with CF_FAIL after one retry without looping", async () => {
      const states = collectStates(bus);

      // Jar is empty (no cached clearance) so we go through LAUNCH_BROWSER

      // After harvest, every GET is still CF-challenged
      const http = {
        get: vi.fn().mockResolvedValue({ statusCode: 403, body: "Just a moment", headers: {} }),
        post: vi.fn().mockResolvedValue({ statusCode: 403, body: "Just a moment", headers: {} }),
        isCloudflareChallenged: vi.fn().mockReturnValue(true),
      };

      // Browser harvest succeeds — we have cookies, but retry still fails
      const browser = makeMockBrowser();
      // FS not available so we don't escalate successfully
      const flaresolverr = makeMockFlaresolverr({ reachable: false });

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      await expect(handler.resolve(makeCfRequest(), ctx)).rejects.toThrow(CfUnsolvableError);

      // Must contain CF_FAIL
      expect(states).toContain("CF_FAIL");

      // RETRY_ORIGINAL must appear exactly once (the post-STORE retry)
      const retryCount = states.filter((s) => s === "CF_RETRY_ORIGINAL").length;
      expect(retryCount).toBe(1);

      // LAUNCH_BROWSER must appear only once — no looping back
      const launchCount = states.filter((s) => s === "CF_LAUNCH_BROWSER").length;
      expect(launchCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // cf.state.entered sequence coverage
  // -------------------------------------------------------------------------

  describe("cf.state.entered sequence coverage", () => {
    it("emits cf.state.entered for every state entered during a jar-hit solve", async () => {
      const enteredStates: string[] = [];
      bus.on((e) => {
        if (e.type === "cf.state.entered") {
          enteredStates.push((e.payload as { state: string }).state);
        }
      });

      const ua = "Mozilla/5.0 (test-ua)";
      jar.set({
        host: "asuracomic.net",
        domain: "asuracomic.net",
        name: "cf_clearance",
        value: "test-clearance",
        path: "/",
        expires: null,
        secure: true,
        httpOnly: false,
        sameSite: null,
        userAgent: ua,
        harvestedAt: new Date().toISOString(),
        lastUsedAt: null,
      });

      const http = makeMockHttp({ status: 200, cfChallenge: false });
      const browser = makeMockBrowser();
      const flaresolverr = makeMockFlaresolverr();

      const ctx: CfResolveContext = {
        http: http as unknown as import("../src/transport/http.js").HttpClient,
        browser: browser as unknown as import("../src/transport/browser.js").BrowserPool,
        jar,
        throttler,
        flaresolverr: flaresolverr as unknown as import("../src/transport/flaresolverr.js").FlareSolverrClient,
        allowHeaded: false,
        eventBus: bus,
      };

      await handler.resolve(makeCfRequest(), ctx);

      // Every state that was entered must have been signalled
      expect(enteredStates.length).toBeGreaterThan(0);
      // The full documented sequence for the jar-hit path
      for (const state of ["CF_DETECT", "CF_CHECK_JAR", "CF_REUSE_CLEARANCE", "CF_RETRY_ORIGINAL", "CF_CLEARED"]) {
        expect(enteredStates).toContain(state);
      }
    });
  });
});
