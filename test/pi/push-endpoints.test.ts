import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the vapid module so isPushConfigured() is true and we can capture pushes.
const mockSendNotification = vi.fn();
const mockIsPushConfigured = vi.fn(() => true);
const mockGetVapidPublicKey = vi.fn<[], string | null>(() => null);

vi.mock("../../src/pi/vapid.js", () => ({
  isPushConfigured: mockIsPushConfigured,
  getVapidPublicKey: mockGetVapidPublicKey,
  webpush: { sendNotification: mockSendNotification },
}));

// Import after vi.mock so both api.ts and pushSender.ts pick up the mock.
const { handleApiRequest } = await import("../../src/pi/api.js");
const { InMemoryAccountStore } = await import("../../src/pi/syncStore.js");
type ApiDeps = import("../../src/pi/api.js").ApiDeps;

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

const SUB = { endpoint: "https://push.example.com/x", keys: { p256dh: "p", auth: "a" } };

describe("push endpoints + new-series trigger", () => {
  let ctx: { server: Server; base: string };
  let store: InstanceType<typeof InMemoryAccountStore>;
  let tokens: string[];

  beforeEach(async () => {
    mockSendNotification.mockReset();
    mockSendNotification.mockResolvedValue({ statusCode: 201 });
    mockIsPushConfigured.mockReset();
    mockIsPushConfigured.mockReturnValue(true);
    mockGetVapidPublicKey.mockReset();
    mockGetVapidPublicKey.mockReturnValue(null);

    const root = mkdtempSync(join(tmpdir(), "pi-push-"));
    const dirs = { jobs: join(root, "jobs"), done: join(root, "done"), state: join(root, "state") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    store = new InMemoryAccountStore(() => "2026-06-17T00:00:00Z");
    tokens = ["tok-1", "tok-2"];
    let t = 0;
    ctx = await startServer({
      dirs,
      secret: SECRET,
      now: () => 1_700_000_000_000,
      newSuffix: () => "abcd",
      corsOrigin: "*",
      store,
      verifyOtp: (code: string) => code === "111111",
      newToken: () => tokens[t++]!,
      newId: (() => { let n = 0; return () => `dev-${++n}`; })(),
    });
  });

  afterEach(() => ctx.server.close());

  async function enroll(): Promise<string> {
    const r = await fetch(`${ctx.base}/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "u", passcode: "p", otp: "111111", deviceName: "d" }),
    });
    return (await r.json()).deviceToken as string;
  }

  it("POST /push/subscribe with no bearer -> 401", async () => {
    const res = await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: SUB }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /push/subscribe with an invalid bearer -> 401", async () => {
    const res = await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ subscription: SUB }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /push/subscribe with a valid token stores the subscription (200)", async () => {
    const tok = await enroll();
    const res = await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ subscription: SUB }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const acc = await store.findAccountByUsername("u");
    expect(acc!.devices[0]!.pushSubscription).toEqual(SUB);
  });

  it("POST /push/subscribe without a subscription field -> 400", async () => {
    const tok = await enroll();
    const res = await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /push/subscribe clears the subscription (200)", async () => {
    const tok = await enroll();
    await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ subscription: SUB }),
    });
    const del = await fetch(`${ctx.base}/push/subscribe`, {
      method: "DELETE", headers: { authorization: `Bearer ${tok}` },
    });
    expect(del.status).toBe(200);
    const acc = await store.findAccountByUsername("u");
    expect(acc!.devices[0]!.pushSubscription).toBeUndefined();
  });

  it("GET /push/vapid-public-key -> 404 when unconfigured", async () => {
    const res = await fetch(`${ctx.base}/push/vapid-public-key`);
    expect(res.status).toBe(404);
  });

  it("GET /push/vapid-public-key -> 200 + key when configured", async () => {
    mockGetVapidPublicKey.mockReturnValue("PUBKEY");
    const res = await fetch(`${ctx.base}/push/vapid-public-key`);
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe("PUBKEY");
  });

  it("PUT /sync/position with a NEW sourceUrl pushes to other subscribed devices; a repeat does not", async () => {
    // Enroll two devices on the same account.
    const tok1 = await enroll();
    const tok2 = await enroll();
    // Device 2 subscribes to push.
    await fetch(`${ctx.base}/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok2}` },
      body: JSON.stringify({ subscription: SUB }),
    });

    // Device 1 records a position for a brand-new series.
    const put1 = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${tok1}` },
      body: JSON.stringify({ sourceUrl: "https://x/new", chapterOrder: 1, pageIndex: 0, manuallyMarked: false }),
    });
    expect(put1.status).toBe(200);

    // notifyNewSeries is fire-and-forget; wait for the microtask queue to flush.
    await vi.waitFor(() => expect(mockSendNotification).toHaveBeenCalledTimes(1));
    const [subArg] = mockSendNotification.mock.calls[0] as [{ endpoint: string }, string];
    expect(subArg.endpoint).toBe(SUB.endpoint);

    // Same sourceUrl again -> not a new series -> no additional push.
    mockSendNotification.mockClear();
    const put2 = await fetch(`${ctx.base}/sync/position`, {
      method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${tok1}` },
      body: JSON.stringify({ sourceUrl: "https://x/new", chapterOrder: 2, pageIndex: 3, manuallyMarked: false }),
    });
    expect(put2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
