import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateJobId, serializeJob, parseJob } from "./job.js";
import { verifyTotp } from "./totp.js";
import type { RunnerDirs } from "./runner.js";
import type { AccountStore } from "./syncStore.js";
import { handleEnroll, resolveDevice, handlePutPosition, handleGetPositions, type SyncDeps } from "./syncHandlers.js";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
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
      const status = await readFile(join(runDir, "status.json"), "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(status);
      return;
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
      const r = await handlePutPosition(
        ctx,
        {
          sourceUrl: String(payload["sourceUrl"] ?? ""),
          chapterOrder: Number(payload["chapterOrder"]),
          pageIndex: Number(payload["pageIndex"]),
          manuallyMarked: !!payload["manuallyMarked"],
        },
        sync,
      );
      return json(res, r.status, r.body);
    }
    if (isGetPositions) {
      const since = url.searchParams.get("since");
      const r = await handleGetPositions(ctx, since, sync);
      return json(res, r.status, r.body);
    }
  }

  json(res, 404, { error: "not found" });
}
