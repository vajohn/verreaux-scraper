import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiRequest, type ApiDeps } from "../../src/pi/api.js";
import { totp } from "../../src/pi/totp.js";

const SECRET = "JBSWY3DPEHPK3PXP";

function startServer(deps: ApiDeps): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => { void handleApiRequest(req, res, deps); });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("api", () => {
  let dirs: { jobs: string; done: string; state: string };
  let ctx: { server: Server; base: string };

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-api-"));
    dirs = { jobs: join(root, "jobs"), done: join(root, "done"), state: join(root, "state") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    ctx = await startServer({
      dirs,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      newSuffix: () => "abcd",
      corsOrigin: "*",
    });
  });

  afterEach(() => ctx.server.close());

  it("rejects POST /scrape with a bad OTP (401) and writes no job", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/s", otp: "000000" }),
    });
    expect(res.status).toBe(401);
    expect(readdirSync(dirs.jobs)).toEqual([]);
  });

  it("accepts POST /scrape with a valid OTP (201) and writes a job file", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/s", args: "--from 1 --to 2", otp: totp(SECRET, 1_700_000_000_000) }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(id).toBe("20231114-221320-abcd");
    const files = readdirSync(dirs.jobs);
    expect(files).toEqual([`${id}.json`]);
    const job = JSON.parse(readFileSync(join(dirs.jobs, files[0]), "utf8"));
    expect(job.url).toBe("https://x.test/s");
    expect(job.args).toBe("--from 1 --to 2");
  });

  it("returns the status for GET /runs/:id", async () => {
    mkdirSync(join(dirs.done, "run9"));
    writeFileSync(join(dirs.done, "run9", "status.json"), JSON.stringify({ state: "succeeded" }));
    const res = await fetch(`${ctx.base}/runs/run9`);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("succeeded");
  });

  it("sets CORS headers and answers preflight", async () => {
    const res = await fetch(`${ctx.base}/scrape`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects a valid-OTP scrape with an invalid (non-http) url (400) and writes no job", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://bad/host", otp: totp(SECRET, 1_700_000_000_000) }),
    });
    expect(res.status).toBe(400);
    expect(readdirSync(dirs.jobs)).toEqual([]);
  });

  it("returns 404 for a run that does not exist", async () => {
    const res = await fetch(`${ctx.base}/runs/nope`);
    expect(res.status).toBe(404);
  });
});
