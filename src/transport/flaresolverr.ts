// ---------------------------------------------------------------------------
// FlareSolverrClient — last-resort cookie harvester via FlareSolverr Docker
//
// Spec requirements:
//   - POST {"cmd":"request.get","url":"<url>","maxTimeout":60000} to endpoint
//   - Parse response cookies into CookieRecord[]
//   - isReachable(): short-timeout health check, returns boolean
//   - If unreachable, emit cf.flaresolverr.unavailable (treated as "skip rung")
//   - Emits cf.fs_call, cf.fs_ok, cf.fs_fail per §13.5
// ---------------------------------------------------------------------------

import type { CookieRecord } from "../core/types.js";
import type { EventBus } from "../core/events.js";

export interface FlareSolverrResponse {
  status: "ok" | "error";
  message: string;
  solution?: {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      size: number;
      httpOnly: boolean;
      secure: boolean;
      session: boolean;
      sameSite: "Strict" | "Lax" | "None" | string;
    }>;
    userAgent: string;
    headers: Record<string, string>;
    response: string;
    status: number;
    url: string;
  };
}

export interface SolveResult {
  cookies: Array<CookieRecord & { host: string }>;
  userAgent: string;
}

export class FlareSolverrClient {
  constructor(
    private readonly endpoint: string = "http://localhost:8191/v1",
    private readonly eventBus: EventBus,
  ) {}

  // ---------------------------------------------------------------------------
  // solve — request clearance cookies for a URL via FlareSolverr
  // ---------------------------------------------------------------------------
  async solve(url: string, abortSignal: AbortSignal): Promise<SolveResult> {
    this.eventBus.emit("cf.fs_call", { url });

    const body = JSON.stringify({
      cmd: "request.get",
      url,
      maxTimeout: 60_000,
    });

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: abortSignal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.eventBus.emit("cf.fs_fail", { url, reason });
      throw err;
    }

    let data: FlareSolverrResponse;
    try {
      data = (await response.json()) as FlareSolverrResponse;
    } catch (err) {
      const reason = "Failed to parse FlareSolverr response JSON";
      this.eventBus.emit("cf.fs_fail", { url, reason });
      throw new Error(reason);
    }

    if (data.status !== "ok" || !data.solution) {
      const reason = data.message || "FlareSolverr returned non-ok status";
      this.eventBus.emit("cf.fs_fail", { url, reason });
      throw new Error(`FlareSolverr error: ${reason}`);
    }

    const { solution } = data;
    const host = new URL(url).hostname;
    const now = new Date().toISOString();

    const cookies: Array<CookieRecord & { host: string }> = solution.cookies.map((c) => {
      const cookieHost = c.domain.startsWith(".")
        ? c.domain.slice(1)
        : c.domain || host;
      return {
        host: cookieHost,
        domain: c.domain || host,
        name: c.name,
        value: c.value,
        path: c.path || "/",
        expires: c.expires > 0 ? c.expires : null,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite:
          c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None"
            ? c.sameSite
            : null,
        userAgent: solution.userAgent,
        harvestedAt: now,
        lastUsedAt: null,
      };
    });

    this.eventBus.emit("cf.fs_ok", { url });

    return { cookies, userAgent: solution.userAgent };
  }

  // ---------------------------------------------------------------------------
  // isReachable — quick health probe with a short timeout (3s)
  // ---------------------------------------------------------------------------
  async isReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const resp = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd: "sessions.list" }),
          signal: controller.signal,
        });
        return resp.ok || resp.status < 500;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }
}
