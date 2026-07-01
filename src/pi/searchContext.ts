// ---------------------------------------------------------------------------
// searchContext — lightweight AdapterContext for in-process synchronous search.
//
// Pure-HTTP adapters never touch the browser; the BrowserPool is created lazily
// via a getter so CF-gated adapters can still access it without spinning up
// Chromium for every search request.
// ---------------------------------------------------------------------------

import pino from "pino";
import type { AdapterContext } from "../core/types.js";
import { CookieJar } from "../transport/cookies.js";
import { Throttler } from "../transport/throttle.js";
import { HttpClient } from "../transport/http.js";
import { BrowserPool } from "../transport/browser.js";
import { EventBus } from "../core/events.js";
import { openStore } from "../state/store.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface SearchContextHandle {
  ctx: AdapterContext;
  cleanup: () => Promise<void>;
}

export function buildSearchContext(): SearchContextHandle {
  // In-memory SQLite store — ephemeral, no disk I/O, discarded on cleanup.
  const store = openStore(":memory:");

  const eventBus = new EventBus();
  const throttler = new Throttler(eventBus, 4);
  const jar = new CookieJar(store);
  const logger = pino({ level: process.env["LOG_LEVEL"] ?? "warn" });
  const controller = new AbortController();

  const http = new HttpClient({
    jar,
    userAgent: DEFAULT_UA,
    eventBus,
    throttler,
  });

  // Browser is created lazily — pure-HTTP adapters never trigger this getter.
  let browser: BrowserPool | null = null;

  const ctx: AdapterContext = {
    http,
    get browser(): BrowserPool {
      if (!browser) browser = new BrowserPool(eventBus, /* headless */ true);
      return browser;
    },
    cookies: jar,
    logger,
    throttle: throttler,
    signal: controller.signal,
  } as AdapterContext;

  const cleanup = async () => {
    controller.abort();
    if (browser) {
      try {
        await browser.close();
      } catch {
        // best-effort
      }
    }
    try {
      store.close();
    } catch {
      // best-effort
    }
  };

  return { ctx, cleanup };
}
