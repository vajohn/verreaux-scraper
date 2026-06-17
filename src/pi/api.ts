import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { generateJobId, serializeJob, parseJob } from "./job.js";
import { verifyTotp } from "./totp.js";
import type { RunnerDirs } from "./runner.js";

export interface ApiDeps {
  dirs: RunnerDirs;
  secret: string;
  now: () => number;
  /** Random id suffix (injectable for deterministic tests). */
  newSuffix: () => string;
  corsOrigin: string;
}

function cors(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
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
    if (!verifyTotp(deps.secret, String(payload["otp"] ?? ""), deps.now())) {
      return json(res, 401, { error: "invalid authenticator code" });
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

  json(res, 404, { error: "not found" });
}
