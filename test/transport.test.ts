// ---------------------------------------------------------------------------
// transport.test.ts — tests for cookies.ts and throttle.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { openStore } from "../src/state/store.js";
import type { Store } from "../src/state/store.js";
import { CookieJar } from "../src/transport/cookies.js";
import { Throttler } from "../src/transport/throttle.js";
import { EventBus } from "../src/core/events.js";
import type { CookieRecord } from "../src/core/types.js";
import { makeTmpDir } from "./setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCookieRecord(
  overrides: Partial<CookieRecord & { host: string }> = {},
): CookieRecord & { host: string } {
  return {
    host: "asuracomic.net",
    domain: "asuracomic.net",
    name: "cf_clearance",
    value: "test-clearance-abc123",
    path: "/",
    expires: null,
    secure: true,
    httpOnly: false,
    sameSite: null,
    userAgent: "Mozilla/5.0 (UA-A)",
    harvestedAt: new Date().toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cookies.ts tests
// ---------------------------------------------------------------------------

describe("CookieJar", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;
  let jar: CookieJar;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    store = openStore(join(dir, "state.sqlite"));
    jar = new CookieJar(store);
  });

  afterEach(() => {
    store.close();
    cleanup();
  });

  // -------------------------------------------------------------------------
  // UA-binding: cf_clearance bound to harvesting UA
  // -------------------------------------------------------------------------

  describe("UA-binding enforcement", () => {
    it("serializeForHost includes cf_clearance when UA matches bound UA", async () => {
      const UA_A = "Mozilla/5.0 (UA-A)";
      jar.set(makeCookieRecord({ userAgent: UA_A }));
      await jar.loadForDomain("asuracomic.net");

      const header = await jar.serializeForHost("asuracomic.net", UA_A);
      expect(header).toContain("cf_clearance");
    });

    it("serializeForHost EXCLUDES cf_clearance when UA does NOT match bound UA", async () => {
      const UA_A = "Mozilla/5.0 (UA-A)";
      const UA_B = "Mozilla/5.0 (UA-B)";

      // Cookie bound to UA-A
      jar.set(makeCookieRecord({ userAgent: UA_A }));
      await jar.loadForDomain("asuracomic.net");

      // Serialize with UA-B → cf_clearance must be excluded
      const header = await jar.serializeForHost("asuracomic.net", UA_B);
      expect(header).not.toContain("cf_clearance");
    });

    it("other cookies (not cf_clearance) are included regardless of UA mismatch", async () => {
      const UA_A = "Mozilla/5.0 (UA-A)";
      const UA_B = "Mozilla/5.0 (UA-B)";

      // Set a regular session cookie bound to UA-A
      jar.set(
        makeCookieRecord({
          name: "session",
          value: "sess-xyz",
          userAgent: UA_A,
        }),
      );
      // Set cf_clearance bound to UA-A
      jar.set(makeCookieRecord({ userAgent: UA_A }));
      await jar.loadForDomain("asuracomic.net");

      // Serialize with UA-B — session should be present, cf_clearance excluded
      const header = await jar.serializeForHost("asuracomic.net", UA_B);
      expect(header).toContain("session");
      expect(header).not.toContain("cf_clearance");
    });

    it("getUaForCfClearance returns the bound UA", () => {
      const UA_A = "Mozilla/5.0 (UA-A)";
      jar.set(makeCookieRecord({ userAgent: UA_A }));
      expect(jar.getUaForCfClearance("asuracomic.net")).toBe(UA_A);
    });
  });

  // -------------------------------------------------------------------------
  // 25-minute freshness window (assumption A9)
  // -------------------------------------------------------------------------

  describe("25-minute freshness window", () => {
    it("hasFreshCfClearance returns true for a cookie harvested now", () => {
      jar.set(makeCookieRecord({ harvestedAt: new Date().toISOString() }));
      expect(jar.hasFreshCfClearance("asuracomic.net")).toBe(true);
    });

    it("hasFreshCfClearance returns false for a cookie harvested 26 minutes ago", () => {
      const oldTs = new Date(Date.now() - 26 * 60 * 1000).toISOString();
      jar.set(makeCookieRecord({ harvestedAt: oldTs }));
      expect(jar.hasFreshCfClearance("asuracomic.net")).toBe(false);
    });

    it("loadForDomain does NOT load a cookie older than 25 minutes into the jar", async () => {
      const oldTs = new Date(Date.now() - 26 * 60 * 1000).toISOString();
      jar.set(makeCookieRecord({ harvestedAt: oldTs }));

      // Create fresh jar from same store — simulates cold start
      const freshJar = new CookieJar(store);
      await freshJar.loadForDomain("asuracomic.net");

      const UA = "Mozilla/5.0 (test)";
      const header = await freshJar.serializeForHost("asuracomic.net", UA);
      // Old cookie must not appear
      expect(header).not.toContain("cf_clearance");
    });

    it("loadForDomain loads a cookie harvested 24 minutes ago (inside window)", async () => {
      const UA = "Mozilla/5.0 (test)";
      const recentTs = new Date(Date.now() - 24 * 60 * 1000).toISOString();
      jar.set(makeCookieRecord({ harvestedAt: recentTs, userAgent: UA }));

      const freshJar = new CookieJar(store);
      await freshJar.loadForDomain("asuracomic.net");

      const header = await freshJar.serializeForHost("asuracomic.net", UA);
      expect(header).toContain("cf_clearance");
    });
  });

  // -------------------------------------------------------------------------
  // clearDomain
  // -------------------------------------------------------------------------

  describe("clearDomain", () => {
    it("removes cookies from store so they cannot be found fresh afterward", () => {
      jar.set(makeCookieRecord());
      expect(jar.hasFreshCfClearance("asuracomic.net")).toBe(true);

      jar.clearDomain("asuracomic.net");
      expect(jar.hasFreshCfClearance("asuracomic.net")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // set / loadForDomain round-trip
  // -------------------------------------------------------------------------

  describe("set and loadForDomain round-trip", () => {
    it("a cookie set via jar.set is visible after loadForDomain on a new jar", async () => {
      const UA = "Mozilla/5.0 (test)";
      jar.set(makeCookieRecord({ userAgent: UA }));

      const secondJar = new CookieJar(store);
      await secondJar.loadForDomain("asuracomic.net");

      const header = await secondJar.serializeForHost("asuracomic.net", UA);
      expect(header).toContain("cf_clearance");
    });
  });
});

// ---------------------------------------------------------------------------
// throttle.ts tests
// ---------------------------------------------------------------------------

describe("Throttler", () => {
  let bus: EventBus;
  let throttler: Throttler;

  beforeEach(() => {
    bus = new EventBus();
    throttler = new Throttler(bus, 3);
  });

  // -------------------------------------------------------------------------
  // Per-host limiters are independent — one host does not block another
  // -------------------------------------------------------------------------

  describe("per-host limiter independence", () => {
    it("requests to different hosts can proceed independently", async () => {
      const results: string[] = [];

      await Promise.all([
        throttler.scheduleForHost("host-a.com", async () => {
          results.push("host-a");
        }),
        throttler.scheduleForHost("host-b.com", async () => {
          results.push("host-b");
        }),
      ]);

      expect(results).toContain("host-a");
      expect(results).toContain("host-b");
    });

    it("scheduleForHost resolves the return value", async () => {
      const result = await throttler.scheduleForHost("example.com", async () => 42);
      expect(result).toBe(42);
    });

    it("scheduleForImageHost resolves the return value", async () => {
      const result = await throttler.scheduleForImageHost("cdn.example.com", async () => "img");
      expect(result).toBe("img");
    });
  });

  // -------------------------------------------------------------------------
  // pauseHost emits rate.backoff event
  // -------------------------------------------------------------------------

  describe("pauseHost", () => {
    it("emits rate.backoff when a host is paused", () => {
      const events: unknown[] = [];
      bus.on((e) => {
        if (e.type === "rate.backoff") events.push(e.payload);
      });

      throttler.pauseHost("example.com", 100);
      expect(events).toHaveLength(1);
      expect((events[0] as { host: string; sleepMs: number }).host).toBe("example.com");
      expect((events[0] as { host: string; sleepMs: number }).sleepMs).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // withCfMutex — serialises concurrent calls for the same host
  // -------------------------------------------------------------------------

  describe("withCfMutex", () => {
    it("serialises two concurrent CF solves for the same host", async () => {
      // Use two sequential calls and verify the second waited for the first
      const completedOrder: number[] = [];
      let p1Resolve!: () => void;
      const p1Hold = new Promise<void>((resolve) => { p1Resolve = resolve; });

      // p1 starts and holds the mutex
      const p1 = throttler.withCfMutex("blocked.com", async () => {
        completedOrder.push(1);
        await p1Hold;
        completedOrder.push(2);
      });

      // Small delay so p1 is picked up by Bottleneck
      await new Promise<void>((r) => setTimeout(r, 20));

      // p2 is queued — it must wait
      const p2 = throttler.withCfMutex("blocked.com", async () => {
        completedOrder.push(3);
      });

      // Release p1
      p1Resolve();

      await Promise.all([p1, p2]);

      // p2 must run after p1 completes — 1, 2 before 3
      expect(completedOrder.indexOf(2)).toBeLessThan(completedOrder.indexOf(3));
    });

    it("different hosts do NOT block each other through withCfMutex", async () => {
      const results: string[] = [];

      await Promise.all([
        throttler.withCfMutex("site-a.com", async () => { results.push("a"); }),
        throttler.withCfMutex("site-b.com", async () => { results.push("b"); }),
      ]);

      expect(results).toContain("a");
      expect(results).toContain("b");
    });
  });

  // -------------------------------------------------------------------------
  // adjustConcurrency — emits rate.throttle_adjusted
  // -------------------------------------------------------------------------

  describe("adjustConcurrency", () => {
    it("emits rate.throttle_adjusted with clamped values", () => {
      const events: unknown[] = [];
      bus.on((e) => {
        if (e.type === "rate.throttle_adjusted") events.push(e.payload);
      });

      throttler.adjustConcurrency("example.com", 1, 1000);
      expect(events).toHaveLength(1);
      expect((events[0] as { newConcurrency: number }).newConcurrency).toBe(1);
    });

    it("clamps newConcurrency to 1 minimum", () => {
      const events: unknown[] = [];
      bus.on((e) => {
        if (e.type === "rate.throttle_adjusted") events.push(e.payload);
      });

      // Passing 0 should clamp to 1
      throttler.adjustConcurrency("example.com", 0, 500);
      expect((events[0] as { newConcurrency: number }).newConcurrency).toBe(1);
    });
  });
});
