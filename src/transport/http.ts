// ---------------------------------------------------------------------------
// HttpClient — factory wrapping got v14 with:
//   - Cookie jar attachment via beforeRequest hook (not got's cookieJar option)
//   - UA pinned per client instance (UA/cookie binding invariant)
//   - afterResponse hook captures set-cookie → CookieJar.set
//   - Referer supplied per-request by caller (no defaulting)
//   - Bottleneck throttle integration
//   - Body types: Buffer for images, string for HTML, parsed JSON for getJson
//   - Events per §13: transport events mapped to existing ScraperEvent types
//
// CF challenge detection (for hooks.afterResponse):
//   - status 403 or 503 AND
//   - either response header cf-mitigated: challenge OR
//   - body contains /Cloudflare|cf-mitigated|__cf_chl|Just a moment/
// ---------------------------------------------------------------------------

import { got } from "got";
import type { Got, Response, OptionsOfTextResponseBody, OptionsOfBufferResponseBody } from "got";
import type { CookieJar } from "./cookies.js";
import type { EventBus } from "../core/events.js";
import type { Throttler } from "./throttle.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HttpClientOptions {
  jar: CookieJar;
  userAgent: string;
  eventBus: EventBus;
  throttler: Throttler;
  /** Request timeout in ms — default 30 000 */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Referer header. If omitted, no Referer header is sent. */
  referer?: string;
  /** Extra headers merged into the request */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface PostOptions extends RequestOptions {
  body?: string;
  form?: Record<string, string>;
}

export class HttpClient {
  private readonly instance: Got;
  private readonly jar: CookieJar;
  private readonly userAgent: string;
  private readonly eventBus: EventBus;
  private readonly throttler: Throttler;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.jar = opts.jar;
    this.userAgent = opts.userAgent;
    this.eventBus = opts.eventBus;
    this.throttler = opts.throttler;
    this.timeoutMs = opts.timeoutMs ?? 30_000;

    // Honor NODE_TLS_REJECT_UNAUTHORIZED at the got level. Some Node + undici
    // code paths reached by got v14 do not consistently consult the env var,
    // so it has to be forwarded explicitly via the https.rejectUnauthorized
    // option for corporate MITM-proxy environments.
    const rejectUnauthorized = process.env["NODE_TLS_REJECT_UNAUTHORIZED"] !== "0";

    // Bounded retries for transient transport errors only (timeouts, connection
    // drops, DNS hiccups). Status-code retries stay off — CF/429 handling lives
    // at a higher layer and would be defeated by blind retry here.
    this.instance = got.extend({
      retry: {
        limit: 2,
        methods: ["GET", "POST"],
        statusCodes: [],
        errorCodes: [
          "ETIMEDOUT",
          "ECONNRESET",
          "EADDRINUSE",
          "ECONNREFUSED",
          "EPIPE",
          "ENOTFOUND",
          "ENETUNREACH",
          "EAI_AGAIN",
          "EHOSTUNREACH",
          "UND_ERR_SOCKET",
        ],
        backoffLimit: 5_000,
      },
      timeout: {
        request: this.timeoutMs,
      },
      followRedirect: true,
      throwHttpErrors: false,
      https: {
        rejectUnauthorized,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // get — HTML / text response (string body)
  // ---------------------------------------------------------------------------
  async get(url: string, opts: RequestOptions = {}): Promise<Response<string>> {
    return this.requestText(url, "GET", opts);
  }

  // ---------------------------------------------------------------------------
  // getJson — parsed JSON response
  // ---------------------------------------------------------------------------
  async getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
    const resp = await this.requestText(url, "GET", opts);
    return JSON.parse(resp.body) as T;
  }

  // ---------------------------------------------------------------------------
  // post — POST with optional form / raw body
  // ---------------------------------------------------------------------------
  async post(url: string, opts: PostOptions = {}): Promise<Response<string>> {
    return this.requestText(url, "POST", opts);
  }

  // ---------------------------------------------------------------------------
  // getImage — Buffer response (no charset decode)
  // ---------------------------------------------------------------------------
  async getImage(url: string, opts: RequestOptions = {}): Promise<Response<Buffer>> {
    return this.requestBuffer(url, opts);
  }

  // ---------------------------------------------------------------------------
  // isCloudflareChallenged — public so CfHandler can use it directly
  // ---------------------------------------------------------------------------
  isCloudflareChallenged(response: Response<string> | Response<Buffer>): boolean {
    const status = response.statusCode;
    if (status !== 403 && status !== 503) return false;

    // Header check
    const cfMitigated = response.headers["cf-mitigated"];
    if (cfMitigated === "challenge") return true;

    const serverHeader = String(response.headers["server"] ?? "").toLowerCase();
    const body = this.extractBodyText(response);

    if (serverHeader === "cloudflare") {
      // With cloudflare server header, body marker is sufficient confirmation
      if (/Cloudflare|cf-mitigated|__cf_chl|Just a moment/i.test(body)) return true;
      // Cloudflare server on 403/503 alone is a strong signal
      return true;
    }

    // Body-only detection (no cloudflare server header)
    return /cf-mitigated|__cf_chl|Just a moment/i.test(body);
  }

  // ---------------------------------------------------------------------------
  // Private: text request engine
  // ---------------------------------------------------------------------------
  private async requestText(
    url: string,
    method: "GET" | "POST",
    opts: PostOptions,
  ): Promise<Response<string>> {
    const host = new URL(url).hostname;
    const startedAt = Date.now();

    const scheduleFn = async (): Promise<Response<string>> => {
      const cookieHeader = await this.jar.serializeForHost(host, this.userAgent);

      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(opts.referer ? { referer: opts.referer } : {}),
        ...(opts.headers ?? {}),
      };

      const gotOpts: OptionsOfTextResponseBody = {
        method,
        headers,
        responseType: "text",
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.form !== undefined ? { form: opts.form } : {}),
      };

      let response: Response<string>;
      try {
        response = await this.instance(url, gotOpts);
      } catch (err) {
        const ms = Date.now() - startedAt;
        this.eventBus.emit("source.probe", { host, status: 0, ms });
        throw err;
      }

      const ms = Date.now() - startedAt;
      const status = response.statusCode;

      this.handleResponseCookies(response, host);
      this.handleResponseStatus(response, host, url, ms);

      return response;
    };

    return this.throttler.scheduleForHost(host, scheduleFn);
  }

  // ---------------------------------------------------------------------------
  // Private: buffer request engine (images)
  // ---------------------------------------------------------------------------
  private async requestBuffer(
    url: string,
    opts: RequestOptions,
  ): Promise<Response<Buffer>> {
    const host = new URL(url).hostname;
    const startedAt = Date.now();

    const scheduleFn = async (): Promise<Response<Buffer>> => {
      const cookieHeader = await this.jar.serializeForHost(host, this.userAgent);

      const headers: Record<string, string> = {
        "user-agent": this.userAgent,
        accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-dest": "image",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(opts.referer ? { referer: opts.referer } : {}),
        ...(opts.headers ?? {}),
      };

      const gotOpts: OptionsOfBufferResponseBody = {
        method: "GET",
        headers,
        responseType: "buffer",
      };

      let response: Response<Buffer>;
      try {
        response = await this.instance.get(url, gotOpts);
      } catch (err) {
        const ms = Date.now() - startedAt;
        this.eventBus.emit("source.probe", { host, status: 0, ms });
        throw err;
      }

      const ms = Date.now() - startedAt;
      this.handleResponseCookies(response, host);
      this.handleResponseStatus(response, host, url, ms);

      return response;
    };

    return this.throttler.scheduleForImageHost(host, scheduleFn);
  }

  // ---------------------------------------------------------------------------
  // handleResponseCookies — extract set-cookie from response and persist
  // ---------------------------------------------------------------------------
  private handleResponseCookies(
    response: Response<string> | Response<Buffer>,
    host: string,
  ): void {
    const setCookieHeaders = response.headers["set-cookie"];
    if (!setCookieHeaders) return;
    const cookies = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : [setCookieHeaders];
    for (const raw of cookies) {
      this.captureSetCookie(raw, host);
    }
  }

  // ---------------------------------------------------------------------------
  // handleResponseStatus — emit events based on HTTP status
  // ---------------------------------------------------------------------------
  private handleResponseStatus(
    response: Response<string> | Response<Buffer>,
    host: string,
    url: string,
    ms: number,
  ): void {
    const status = response.statusCode;

    // 429 — rate limited
    if (status === 429) {
      const retryAfterRaw = response.headers["retry-after"];
      const retryAfter =
        retryAfterRaw !== undefined ? parseInt(String(retryAfterRaw), 10) || null : null;
      this.eventBus.emit("rate.detect", { host, retryAfter });
      return;
    }

    // CF challenge detection: 403 or 503 with CF fingerprint
    if (status === 403 || status === 503) {
      const isCfChallenge = this.isCloudflareChallenged(response);
      if (isCfChallenge) {
        const reason = status === 403 ? "status_403" : "status_503";
        this.eventBus.emit("cf.detected", { host, reason, status });
        return;
      }
    }

    this.eventBus.emit("source.probe", { host, status, ms });
  }

  // ---------------------------------------------------------------------------
  // captureSetCookie — parse a raw set-cookie header value and persist it.
  // ---------------------------------------------------------------------------
  private captureSetCookie(raw: string, host: string): void {
    const parts = raw.split(/;\s*/);
    const first = parts[0] ?? "";
    const eqIdx = first.indexOf("=");
    if (eqIdx === -1) return;

    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();

    let domain = host;
    let path = "/";
    let expires: number | null = null;
    let secure = false;
    let httpOnly = false;

    for (const part of parts.slice(1)) {
      const lower = part.toLowerCase().trim();
      if (lower === "secure") { secure = true; continue; }
      if (lower === "httponly") { httpOnly = true; continue; }
      if (lower.startsWith("domain=")) {
        domain = part.slice("domain=".length).trim();
        continue;
      }
      if (lower.startsWith("path=")) {
        path = part.slice("path=".length).trim();
        continue;
      }
      if (lower.startsWith("expires=")) {
        const d = new Date(part.slice("expires=".length).trim());
        if (!isNaN(d.getTime())) expires = Math.floor(d.getTime() / 1000);
        continue;
      }
      if (lower.startsWith("max-age=")) {
        const seconds = parseInt(part.slice("max-age=".length).trim(), 10);
        if (!isNaN(seconds)) expires = Math.floor(Date.now() / 1000) + seconds;
        continue;
      }
    }

    this.jar.set({
      host,
      domain,
      name,
      value,
      path,
      expires,
      secure,
      httpOnly,
      sameSite: null,
      userAgent: this.userAgent,
      harvestedAt: new Date().toISOString(),
      lastUsedAt: null,
    });
  }

  // ---------------------------------------------------------------------------
  // extractBodyText — safely get text preview from a response body
  // ---------------------------------------------------------------------------
  private extractBodyText(response: Response<string> | Response<Buffer>): string {
    if (typeof response.body === "string") return response.body;
    if (response.body instanceof Buffer) return response.body.toString("utf8", 0, 4096);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------
export function createHttpClient(opts: HttpClientOptions): HttpClient {
  return new HttpClient(opts);
}
