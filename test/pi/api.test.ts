import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiRequest, type ApiDeps } from "../../src/pi/api.js";
import { totp } from "../../src/pi/totp.js";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";

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
  let store: InMemoryAccountStore;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-api-"));
    dirs = { jobs: join(root, "jobs"), done: join(root, "done"), state: join(root, "state") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    store = new InMemoryAccountStore(() => "2026-06-17T00:00:00Z");
    ctx = await startServer({
      dirs,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      newSuffix: () => "abcd",
      corsOrigin: "*",
      store,
      verifyOtp: (code: string) => code === "111111",
      newToken: () => "tok-plain",
      newId: (() => { let n = 0; return () => `dev-${++n}`; })(),
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

  it("surfaces partial/hasOutput/exitCode for a rate-limited run on GET /runs/:id", async () => {
    mkdirSync(join(dirs.done, "run5"));
    writeFileSync(
      join(dirs.done, "run5", "status.json"),
      JSON.stringify({ state: "failed", exitCode: 5, partial: true, hasOutput: true, message: "rate limited" }),
    );
    const res = await fetch(`${ctx.base}/runs/run5`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("failed");
    expect(body.exitCode).toBe(5);
    expect(body.partial).toBe(true);
    expect(body.hasOutput).toBe(true);
  });

  it("defaults partial/hasOutput to false when a legacy status.json omits them", async () => {
    mkdirSync(join(dirs.done, "run6"));
    writeFileSync(join(dirs.done, "run6", "status.json"), JSON.stringify({ state: "succeeded", exitCode: 0 }));
    const res = await fetch(`${ctx.base}/runs/run6`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partial).toBe(false);
    expect(body.hasOutput).toBe(false);
    expect(body.exitCode).toBe(0);
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

  it("enrolls a device (bad OTP -> 401, good OTP -> 201 token)", async () => {
    const bad = await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "000000", deviceName: "iPad" }),
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).deviceToken).toBe("tok-plain");
  });

  it("rejects sync without a valid bearer token (401)", async () => {
    const res = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: "https://x/s", chapterOrder: 1, pageIndex: 0, manuallyMarked: false }),
    });
    expect(res.status).toBe(401);
  });

  it("PUT then GET a position with a bearer token", async () => {
    await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
    });
    const auth = { "content-type": "application/json", authorization: "Bearer tok-plain" };
    const put = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ sourceUrl: "https://x/s", chapterOrder: 12, pageIndex: 5, manuallyMarked: false }),
    });
    expect(put.status).toBe(200);
    expect((await put.json()).pageIndex).toBe(5);
    const get = await fetch(`${ctx.base}/sync/positions`, { headers: { authorization: "Bearer tok-plain" } });
    expect(get.status).toBe(200);
    expect((await get.json()).positions).toHaveLength(1);
  });

  it("accepts POST /scrape with a valid device bearer token and no OTP (201)", async () => {
    await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }),
    });
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-plain" },
      body: JSON.stringify({ url: "https://x.test/s", args: "--from 49 --to latest" }),
    });
    expect(res.status).toBe(201);
    expect(readdirSync(dirs.jobs)).toHaveLength(1);
    const files = readdirSync(dirs.jobs);
    const job = JSON.parse(readFileSync(join(dirs.jobs, files[0]!), "utf8"));
    expect(job.url).toBe("https://x.test/s");
    expect(job.args).toBe("--from 49 --to latest");
  });

  it("rejects POST /scrape with an invalid bearer token and no OTP (401)", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ url: "https://x.test/s" }),
    });
    expect(res.status).toBe(401);
    expect(readdirSync(dirs.jobs)).toEqual([]);
  });

  it("still accepts POST /scrape with a valid OTP and no token (201)", async () => {
    const res = await fetch(`${ctx.base}/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://x.test/s", otp: totp(SECRET, 1_700_000_000_000) }),
    });
    expect(res.status).toBe(201);
    expect(readdirSync(dirs.jobs)).toHaveLength(1);
  });
});
