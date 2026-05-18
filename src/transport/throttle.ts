// ---------------------------------------------------------------------------
// Throttler — Bottleneck groups per §16
//
// Groups:
//   host:<sourceDomain>  — series + chapter HTML fetches: maxConcurrent=2, minTime=500ms
//   img:<imageHost>      — image GETs: maxConcurrent=concurrency(default 3,cap 5), minTime=100ms
//   cf:<host>            — CF challenge mutex: maxConcurrent=1 (serialises browser launches)
//
// pauseHost / resumeHost implement 429 backoff by calling updateSettings on the
// relevant host limiter, reducing minTime to Infinity then restoring it.
// ---------------------------------------------------------------------------

import Bottleneck from "bottleneck";
import type { EventBus } from "../core/events.js";

export class Throttler {
  private readonly hostLimiters = new Map<string, Bottleneck>();
  private readonly imgLimiters = new Map<string, Bottleneck>();
  private readonly cfMutexes = new Map<string, Bottleneck>();

  // concurrency is the --concurrency CLI flag (default 3, max 5)
  constructor(
    private readonly eventBus: EventBus,
    private readonly imageConcurrency: number = 3,
  ) {}

  // ---------------------------------------------------------------------------
  // scheduleForHost — throttle a page/chapter HTML request for a source host.
  // §16: maxConcurrent=2, minTime=500ms
  // ---------------------------------------------------------------------------
  scheduleForHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
    return this.getHostLimiter(host).schedule(fn);
  }

  // ---------------------------------------------------------------------------
  // scheduleForImageHost — throttle an image CDN request.
  // §16: maxConcurrent=concurrency(default 3,cap 5), minTime=100ms
  // ---------------------------------------------------------------------------
  scheduleForImageHost<T>(imgHost: string, fn: () => Promise<T>): Promise<T> {
    return this.getImgLimiter(imgHost).schedule(fn);
  }

  // ---------------------------------------------------------------------------
  // withCfMutex — run fn exclusively per host.
  // §16: maxConcurrent=1 — serialises CF challenge solves.
  // ---------------------------------------------------------------------------
  withCfMutex<T>(host: string, fn: () => Promise<T>): Promise<T> {
    return this.getCfMutex(host).schedule(fn);
  }

  // ---------------------------------------------------------------------------
  // pauseHost — suspend scheduling for a host for `ms` milliseconds.
  // Used by 429 backoff: sets minTime to a very high value to block new
  // requests, then sets a timer to restore original settings.
  // ---------------------------------------------------------------------------
  pauseHost(host: string, ms: number): void {
    const limiter = this.getHostLimiter(host);
    // Drain reservoir to 0 and set a huge minTime to stop new jobs being picked up
    limiter.updateSettings({ reservoir: 0, reservoirRefreshInterval: ms, reservoirRefreshAmount: 2 });

    this.eventBus.emit("rate.backoff", { host, sleepMs: ms });

    setTimeout(() => {
      this.resumeHost(host);
    }, ms);
  }

  // ---------------------------------------------------------------------------
  // resumeHost — restore a paused host limiter to normal operating settings.
  // ---------------------------------------------------------------------------
  resumeHost(host: string): void {
    const limiter = this.getHostLimiter(host);
    // Restore normal settings — clear reservoir throttle
    limiter.updateSettings({
      reservoir: null,
      reservoirRefreshInterval: null as unknown as undefined,
      reservoirRefreshAmount: null as unknown as undefined,
    });
    this.eventBus.emit("rate.backoff", { host, sleepMs: 0 });
  }

  // ---------------------------------------------------------------------------
  // adjustConcurrency — called on burst 429 (§11.1 row 3).
  // Drops host limiter maxConcurrent by 1 (floor 1).
  // ---------------------------------------------------------------------------
  adjustConcurrency(host: string, newConcurrency: number, newMinTime: number): void {
    const clamped = Math.max(1, newConcurrency);
    const limiter = this.getHostLimiter(host);
    limiter.updateSettings({ maxConcurrent: clamped, minTime: newMinTime });

    this.eventBus.emit("rate.throttle_adjusted", {
      newConcurrency: clamped,
      newRatePerSec: 1000 / newMinTime,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: limiter factories
  // ---------------------------------------------------------------------------

  private getHostLimiter(host: string): Bottleneck {
    let limiter = this.hostLimiters.get(host);
    if (!limiter) {
      limiter = new Bottleneck({ maxConcurrent: 2, minTime: 500 });
      this.hostLimiters.set(host, limiter);
    }
    return limiter;
  }

  private getImgLimiter(imgHost: string): Bottleneck {
    let limiter = this.imgLimiters.get(imgHost);
    if (!limiter) {
      const concurrency = Math.min(this.imageConcurrency, 5);
      limiter = new Bottleneck({ maxConcurrent: concurrency, minTime: 100 });
      this.imgLimiters.set(imgHost, limiter);
    }
    return limiter;
  }

  private getCfMutex(host: string): Bottleneck {
    let mutex = this.cfMutexes.get(host);
    if (!mutex) {
      mutex = new Bottleneck({ maxConcurrent: 1 });
      this.cfMutexes.set(host, mutex);
    }
    return mutex;
  }
}
