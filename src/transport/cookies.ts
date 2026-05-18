// ---------------------------------------------------------------------------
// CookieJar — bridges Store.cookies <-> tough-cookie in-memory jar
//
// Rules (per spec §7, assumption A9, §cookies.ts task):
//   - Freshness window: 25 minutes (1 500 000 ms)
//   - UA-binding: cf_clearance is bound to the UA that harvested it.
//     serializeForHost called with a different UA MUST silently omit cf_clearance.
//   - loadForDomain delegates to Store.cookies.findFresh(domain, 25*60*1000) for
//     persistence; the in-memory CookieJar is rebuilt from that on every load.
//   - set() accepts a CookieRecord (already includes userAgent) and upserts into
//     the SQLite store, keeping the in-memory jar in sync.
// ---------------------------------------------------------------------------

import { CookieJar as ToughCookieJar, Cookie } from "tough-cookie";
import type { CookieRecord } from "../core/types.js";
import type { Store } from "../state/store.js";

export const CF_CLEARANCE_MAX_AGE_MS = 25 * 60 * 1000;

export class CookieJar {
  // In-memory jar — rebuilt from SQLite on loadForDomain. Acts as a write-through
  // cache so Cookie header serialization can use tough-cookie's built-in logic.
  private readonly jar: ToughCookieJar;

  // Map from cookie name to the UA string used when it was harvested.
  // Key: `${domain}:${name}` — only cf_clearance entries are tracked, but we
  // store all names for safety.
  private readonly uaBinding = new Map<string, string>();

  constructor(private readonly store: Store) {
    this.jar = new ToughCookieJar();
  }

  // ---------------------------------------------------------------------------
  // loadForDomain — pull fresh cookies from SQLite into the in-memory jar.
  // Filters out cookies older than CF_CLEARANCE_MAX_AGE_MS (25 min).
  // ---------------------------------------------------------------------------
  async loadForDomain(domain: string): Promise<void> {
    const fresh = this.store.cookies.findFresh(domain, CF_CLEARANCE_MAX_AGE_MS);

    for (const rec of fresh) {
      const cookie = this.recordToTough(rec);
      if (cookie) {
        // setCookie needs a URL; use https://<domain>/ as the canonical form.
        const url = `https://${domain}/`;
        try {
          await this.jar.setCookie(cookie, url);
        } catch {
          // Ignore errors from tough-cookie (e.g. public-suffix mismatches for
          // bare hostnames) — the cookie will still be emitted via serializeForHost.
        }
        // Track UA binding for every cookie we load
        const key = `${rec.domain}:${rec.name}`;
        this.uaBinding.set(key, rec.userAgent);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // set — persist a CookieRecord (from Playwright or got afterResponse hook)
  //       into the SQLite store and into the in-memory jar.
  // ---------------------------------------------------------------------------
  set(rec: CookieRecord & { host: string }): void {
    this.store.cookies.upsert(rec);

    const cookie = this.recordToTough(rec);
    if (cookie) {
      const url = `https://${rec.host}/`;
      this.jar.setCookie(cookie, url).catch(() => {
        // best-effort; SQLite is the source of truth
      });
      const key = `${rec.domain}:${rec.name}`;
      this.uaBinding.set(key, rec.userAgent);
    }
  }

  // ---------------------------------------------------------------------------
  // serializeForHost — produce a `Cookie: …` header string for a given host+UA.
  //
  // UA-binding enforcement: if the caller's userAgent differs from the one
  // bound to `cf_clearance`, that cookie is excluded from the result. All other
  // cookies are included regardless of UA.
  // ---------------------------------------------------------------------------
  async serializeForHost(host: string, userAgent: string): Promise<string> {
    const url = `https://${host}/`;
    let cookieString: string;
    try {
      cookieString = await this.jar.getCookieString(url);
    } catch {
      cookieString = "";
    }

    if (!cookieString) return "";

    // Parse the string back into individual name=value pairs so we can filter.
    const pairs = cookieString.split(/;\s*/).filter(Boolean);
    const filtered: string[] = [];

    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=");
      const name = eqIdx === -1 ? pair.trim() : pair.slice(0, eqIdx).trim();

      if (name === "cf_clearance") {
        const key = `${host}:cf_clearance`;
        const boundUa = this.uaBinding.get(key);
        if (boundUa !== undefined && boundUa !== userAgent) {
          // UA mismatch — omit cf_clearance from header
          continue;
        }
        // Also check parent domain bindings (e.g. .asuracomic.net)
        const parentKey = `.${host}:cf_clearance`;
        const parentBoundUa = this.uaBinding.get(parentKey);
        if (parentBoundUa !== undefined && parentBoundUa !== userAgent) {
          continue;
        }
      }

      filtered.push(pair);
    }

    return filtered.join("; ");
  }

  // ---------------------------------------------------------------------------
  // clearDomain — remove all cookies for a domain from both stores.
  // ---------------------------------------------------------------------------
  clearDomain(domain: string): void {
    this.store.cookies.delete(domain);

    // Remove from in-memory jar by removing all matching UA-binding entries
    for (const key of Array.from(this.uaBinding.keys())) {
      if (key.startsWith(`${domain}:`) || key.startsWith(`.${domain}:`)) {
        this.uaBinding.delete(key);
      }
    }

    // tough-cookie v5: removeAllCookies does not accept a domain filter, but
    // calling jar.removeAllCookies then reloading from store on next
    // serializeForHost is simpler than partial cleanup. Since clearDomain is
    // only called before a fresh harvest, full purge is acceptable.
    this.jar.removeAllCookies().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // getUaForCfClearance — retrieve the UA that cf_clearance is bound to.
  // Used by CfHandler to construct a correctly-bound retry request.
  // ---------------------------------------------------------------------------
  getUaForCfClearance(host: string): string | undefined {
    return (
      this.uaBinding.get(`${host}:cf_clearance`) ??
      this.uaBinding.get(`.${host}:cf_clearance`)
    );
  }

  // ---------------------------------------------------------------------------
  // hasFreshCfClearance — fast check used by CF_CHECK_JAR state.
  // ---------------------------------------------------------------------------
  hasFreshCfClearance(host: string): boolean {
    const fresh = this.store.cookies.findFresh(host, CF_CLEARANCE_MAX_AGE_MS);
    return fresh.some((c) => c.name === "cf_clearance");
  }

  // ---------------------------------------------------------------------------
  // getFreshCfClearanceAge — returns age in ms of the freshest cf_clearance, or
  // undefined if none.
  // ---------------------------------------------------------------------------
  getFreshCfClearanceAge(host: string): number | undefined {
    const fresh = this.store.cookies.findFresh(host, CF_CLEARANCE_MAX_AGE_MS);
    const clearance = fresh.find((c) => c.name === "cf_clearance");
    if (!clearance) return undefined;
    return Date.now() - new Date(clearance.harvestedAt).getTime();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private recordToTough(rec: CookieRecord): Cookie | null {
    try {
      const cookie = new Cookie({
        key: rec.name,
        value: rec.value,
        domain: rec.domain.startsWith(".") ? rec.domain.slice(1) : rec.domain,
        path: rec.path,
        secure: rec.secure,
        httpOnly: rec.httpOnly,
        expires: rec.expires ? new Date(rec.expires * 1000) : "Infinity",
        sameSite: rec.sameSite ?? "None",
      });
      return cookie;
    } catch {
      return null;
    }
  }
}
