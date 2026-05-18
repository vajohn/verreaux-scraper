import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { RunConfig, AdapterContext } from "./types.js";
import { EventBus, createPinoSink } from "./events.js";
import { openStore, type Store } from "../state/store.js";
import { CookieJar } from "../transport/cookies.js";
import { Throttler } from "../transport/throttle.js";
import { BrowserPool } from "../transport/browser.js";
import { CfHandler } from "../transport/cf.js";
import { FlareSolverrClient } from "../transport/flaresolverr.js";
import { HttpClient } from "../transport/http.js";

export interface RunContext {
  ctx: AdapterContext;
  http: HttpClient;
  browser: BrowserPool;
  jar: CookieJar;
  store: Store;
  throttler: Throttler;
  cf: CfHandler;
  eventBus: EventBus;
  cleanup: () => Promise<void>;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function buildRunContext(config: RunConfig): Promise<RunContext> {
  const cacheDir = join(config.out, ".verreaux-cache");
  await mkdir(cacheDir, { recursive: true });

  const dbPath = join(cacheDir, "state.sqlite");
  const store = openStore(dbPath);

  const eventBus = new EventBus();

  const pinoLogger = createPinoSink({
    level: "debug",
    ...(config.log === "pretty"
      ? { transport: { target: "pino-pretty" } }
      : {}),
  });

  const jar = new CookieJar(store);
  const throttler = new Throttler(eventBus, config.concurrency);
  // BrowserPool's second arg is `headless`: true = no UI, false = visible window.
  // --allow-headed-cloudflare sets config.headful=true, so invert.
  const browser = new BrowserPool(eventBus, !config.headful);

  const flaresolverr = config.flaresolverrUrl != null
    ? new FlareSolverrClient(config.flaresolverrUrl, eventBus)
    : null;

  const cf = new CfHandler();

  const http = new HttpClient({
    jar,
    userAgent: DEFAULT_UA,
    eventBus,
    throttler,
  });

  const signal = new AbortController().signal;

  const ctx: AdapterContext = {
    http,
    browser,
    cookies: jar,
    logger: pinoLogger,
    throttle: throttler,
    signal,
    config,
  };

  const cleanup = async () => {
    try {
      await browser.close();
    } catch {
    }
    try {
      store.close();
    } catch {
    }
  };

  return { ctx, http, browser, jar, store, throttler, cf, eventBus, cleanup };
}
