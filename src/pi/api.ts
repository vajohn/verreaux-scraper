import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateJobId, serializeJob, parseJob } from "./job.js";
import { verifyTotp } from "./totp.js";
import type { RunnerDirs } from "./runner.js";
import type { RunStatus } from "./status.js";
import type { AccountStore, PushSubscriptionJSON } from "./syncStore.js";
import { handleEnroll, resolveDevice, handlePutPosition, handleGetPositions, type SyncDeps } from "./syncHandlers.js";
import { getVapidPublicKey, isPushConfigured } from "./vapid.js";
import { notifyNewSeries } from "./pushSender.js";

/** Shape returned by GET /runs/:id. Extends the on-disk RunStatus, guaranteeing
 *  the partial/hasOutput/exitCode fields are always present in the response. */
export type RunStatusResponse = RunStatus & {
  exitCode: number | null;
  partial: boolean;
  hasOutput: boolean;
};

export interface ApiDeps {
  dirs: RunnerDirs;
  secret: string;
  now: () => number;
  /** Random id suffix (injectable for deterministic tests). */
  newSuffix: () => string;
  corsOrigin: string;
  /** Sync backend (omit to disable the /enroll + /sync routes). */
  store?: AccountStore;
  verifyOtp?: (code: string) => boolean;
  newToken?: () => string;
  newId?: () => string;
}

function cors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  // PUT + authorization are needed by the sync routes; harmless for the others.
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim() || null;
}

function syncDeps(deps: ApiDeps): SyncDeps | null {
  if (!deps.store || !deps.verifyOtp || !deps.newToken || !deps.newId) return null;
  return {
    store: deps.store,
    verifyOtp: deps.verifyOtp,
    now: () => new Date(deps.now()).toISOString(),
    newToken: deps.newToken,
    newId: deps.newId,
  };
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  cors(res, deps.corsOrigin);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Resolved once up-front: /scrape may authorize via a device token, and the
  // /enroll + /sync routes need it too. Null when the sync backend is disabled.
  // Safe to call unconditionally because syncDeps is pure and synchronous.
  const sync = syncDeps(deps);

  if (req.method === "POST" && path === "/scrape") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(res, 400, { error: "expected a JSON object body" });
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    // Authorize on EITHER a valid OTP or a valid device bearer token. The token
    // path lets sync-driven (catch-up) downloads run without an OTP prompt; it
    // is only available when the sync backend is configured.
    let authed = verifyTotp(deps.secret, String(payload["otp"] ?? ""), deps.now());
    if (!authed && sync) {
      // resolveDevice touches the device's last-seen — fine here: a sync-driven scrape is genuine device activity.
      authed = (await resolveDevice(bearer(req), sync)) !== null;
    }
    if (!authed) {
      return json(res, 401, { error: "invalid authenticator code or device token" });
    }
    const id = generateJobId(new Date(deps.now()), deps.newSuffix());
    let jobJson: string;
    try {
      jobJson = serializeJob(
        parseJob(
          JSON.stringify({
            id,
            type: payload["type"] ?? "scrape",
            url: payload["url"],
            args: payload["args"] ?? "",
          }),
        ),
      );
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    await writeFile(join(deps.dirs.jobs, `${id}.json`), jobJson);
    return json(res, 201, { id });
  }

  const runMatch = path.match(/^\/runs\/([^/]+)(\/output\.zip|\/log)?$/);
  if (req.method === "GET" && runMatch) {
    const id = runMatch[1]!;
    const sub = runMatch[2];
    const runDir = join(deps.dirs.done, id);
    try {
      if (sub === "/output.zip") {
        const files = (await readdir(runDir)).filter((f) => f.endsWith(".zip"));
        const zip = files[0];
        if (zip === undefined) return json(res, 404, { error: "no zip yet" });
        res.statusCode = 200;
        res.setHeader("content-type", "application/zip");
        // Sanitize the filesystem-derived name before putting it in a header.
        const safeName = zip.replace(/[^A-Za-z0-9._-]/g, "_");
        res.setHeader("content-disposition", `attachment; filename="${safeName}"`);
        // A stream error after headers are sent can't become a 404; end the
        // response rather than letting an unhandled 'error' crash the process.
        createReadStream(join(runDir, zip)).on("error", () => res.end()).pipe(res);
        return;
      }
      if (sub === "/log") {
        // readFile (not a stream) so a missing log stays inside this try and
        // returns a proper 404 via the catch below. Logs are small.
        const logText = await readFile(join(runDir, "run.log"), "utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end(logText);
        return;
      }
      const raw = await readFile(join(runDir, "status.json"), "utf8");
      // Augment the on-disk status so the response always carries the
      // partial/hasOutput/exitCode fields the PWA relies on, even for older
      // status files written before the rate-limit-salvage change.
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const body: RunStatusResponse = {
        ...(parsed as unknown as RunStatusResponse),
        exitCode: typeof parsed["exitCode"] === "number" ? (parsed["exitCode"] as number) : null,
        partial: parsed["partial"] === true,
        hasOutput: parsed["hasOutput"] === true,
      };
      return json(res, 200, body);
    } catch {
      return json(res, 404, { error: "run not found" });
    }
  }

  if (sync && req.method === "POST" && path === "/enroll") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json(res, 400, { error: "expected a JSON object body" });
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const r = await handleEnroll(
      {
        username: String(payload["username"] ?? ""),
        passcode: String(payload["passcode"] ?? ""),
        otp: String(payload["otp"] ?? ""),
        deviceName: String(payload["deviceName"] ?? "device"),
      },
      sync,
    );
    return json(res, r.status, r.body);
  }

  // Gate on method+path so a wrong-method request (e.g. GET /sync/position)
  // falls through to 404 without resolving/touching the device.
  const isPutPosition = req.method === "PUT" && path === "/sync/position";
  const isGetPositions = req.method === "GET" && path === "/sync/positions";
  if (sync && (isPutPosition || isGetPositions)) {
    const ctx = await resolveDevice(bearer(req), sync);
    if (!ctx) return json(res, 401, { error: "invalid device token" });

    if (isPutPosition) {
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { error: "expected a JSON object body" });
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const sourceUrl = String(payload["sourceUrl"] ?? "");
      const r = await handlePutPosition(
        ctx,
        {
          sourceUrl,
          chapterOrder: Number(payload["chapterOrder"]),
          pageIndex: Number(payload["pageIndex"]),
          manuallyMarked: !!payload["manuallyMarked"],
        },
        sync,
      );
      json(res, r.status, r.body);
      // Best-effort: notify other devices of a newly-tracked series. Fire-and-forget
      // AFTER the response is sent so it never blocks or fails the PUT.
      if (r.isNewSeries && isPushConfigured()) {
        void notifyNewSeries(sync.store, ctx.account.id, ctx.device.id, sourceUrl);
      }
      return;
    }
    if (isGetPositions) {
      const since = url.searchParams.get("since");
      const r = await handleGetPositions(ctx, since, sync);
      return json(res, r.status, r.body);
    }
  }

  if (req.method === "GET" && path === "/adapters") {
    const { listAdapters } = await import("./searchService.js");
    const { adapterRegistry } = await import("../adapters/index.js");
    return json(res, 200, { adapters: listAdapters(adapterRegistry) });
  }

  if (req.method === "POST" && path === "/search") {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(res, 400, { error: "expected a JSON object body" });
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    // Authorize on EITHER a valid OTP or a valid device bearer token — same
    // policy as /scrape. The token path is only available when sync is configured.
    let authed = verifyTotp(deps.secret, String(payload["otp"] ?? ""), deps.now());
    if (!authed && sync) {
      authed = (await resolveDevice(bearer(req), sync)) !== null;
    }
    if (!authed) {
      return json(res, 401, { error: "invalid authenticator code or device token" });
    }
    const q = String(payload["q"] ?? "").trim();
    if (q.length < 2) return json(res, 400, { error: "query too short" });
    const sources = Array.isArray(payload["sources"]) ? (payload["sources"] as string[]) : undefined;
    const { buildSearchContext } = await import("./searchContext.js");
    const { runSearch } = await import("./searchService.js");
    const { adapterRegistry } = await import("../adapters/index.js");
    const { ctx, cleanup } = buildSearchContext();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("search timeout")), 15_000);
      });
      const outcome = await Promise.race([runSearch(adapterRegistry, ctx, q, sources), timeout]);
      return json(res, 200, outcome);
    } catch (err) {
      return json(res, 200, { results: [], errors: [{ adapterId: "*", error: String((err as Error).message) }] });
    } finally {
      if (timer) clearTimeout(timer);
      await cleanup();
    }
  }

  if (req.method === "GET" && path === "/push/vapid-public-key") {
    const key = getVapidPublicKey();
    if (!key) return json(res, 404, { error: "push not configured" });
    return json(res, 200, { key });
  }

  if (sync && req.method === "POST" && path === "/push/subscribe") {
    const ctx = await resolveDevice(bearer(req), sync);
    if (!ctx) return json(res, 401, { error: "invalid device token" });
    let payload: Record<string, unknown>;
    try {
      const p = JSON.parse(await readBody(req)) as unknown;
      if (typeof p !== "object" || p === null || Array.isArray(p)) return json(res, 400, { error: "expected a JSON object body" });
      payload = p as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const subscription = payload["subscription"];
    if (!subscription || typeof subscription !== "object") return json(res, 400, { error: "subscription required" });
    await sync.store.setDevicePushSubscription(ctx.account.id, ctx.device.id, subscription as PushSubscriptionJSON);
    return json(res, 200, { ok: true });
  }

  if (sync && req.method === "DELETE" && path === "/push/subscribe") {
    const ctx = await resolveDevice(bearer(req), sync);
    if (!ctx) return json(res, 401, { error: "invalid device token" });
    await sync.store.setDevicePushSubscription(ctx.account.id, ctx.device.id, null);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
}
