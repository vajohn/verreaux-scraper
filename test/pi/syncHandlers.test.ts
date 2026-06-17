import { describe, it, expect } from "vitest";
import { InMemoryAccountStore } from "../../src/pi/syncStore.js";
import { handleEnroll, resolveDevice, handlePutPosition, handleGetPositions, type SyncDeps } from "../../src/pi/syncHandlers.js";
import { hashToken } from "../../src/pi/tokens.js";

function deps(store: InMemoryAccountStore): SyncDeps {
  return {
    store,
    verifyOtp: (code) => code === "111111",
    now: () => "2026-06-17T00:00:00Z",
    newToken: () => "tok-plain",
    newId: (() => { let n = 0; return () => `id-${++n}`; })(),
  };
}

describe("handleEnroll", () => {
  it("rejects a bad OTP with 401, creates no account", async () => {
    const store = new InMemoryAccountStore();
    const r = await handleEnroll({ username: "u", passcode: "p", otp: "000000", deviceName: "iPad" }, deps(store));
    expect(r.status).toBe(401);
    expect(await store.findAccountByUsername("u")).toBeNull();
  });

  it("creates a new account + device and returns a token on good OTP", async () => {
    const store = new InMemoryAccountStore();
    const r = await handleEnroll({ username: "u", passcode: "p", otp: "111111", deviceName: "iPad" }, deps(store));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ deviceToken: "tok-plain" });
    const found = await store.findByDeviceTokenHash(hashToken("tok-plain"));
    expect(found?.device.name).toBe("iPad");
  });

  it("rejects a wrong passcode for an existing username (401)", async () => {
    const store = new InMemoryAccountStore();
    await handleEnroll({ username: "u", passcode: "right", otp: "111111", deviceName: "A" }, deps(store));
    const r = await handleEnroll({ username: "u", passcode: "wrong", otp: "111111", deviceName: "B" }, deps(store));
    expect(r.status).toBe(401);
  });
});

describe("resolveDevice + position handlers", () => {
  async function enrolled() {
    const store = new InMemoryAccountStore();
    const d = deps(store);
    await handleEnroll({ username: "u", passcode: "p", otp: "111111", deviceName: "A" }, d);
    return { store, d };
  }

  it("resolves a device from a bearer token, rejects unknown", async () => {
    const { d } = await enrolled();
    expect(await resolveDevice("tok-plain", d)).not.toBeNull();
    expect(await resolveDevice("bogus", d)).toBeNull();
  });

  it("PUT position merges and GET returns it", async () => {
    const { d } = await enrolled();
    const ctx = (await resolveDevice("tok-plain", d))!;
    const put = await handlePutPosition(ctx, { sourceUrl: "https://x/s", chapterOrder: 12, pageIndex: 5, manuallyMarked: false }, d);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ chapterOrder: 12, pageIndex: 5 });
    const got = await handleGetPositions(ctx, null, d);
    expect(got.status).toBe(200);
    expect((got.body as { positions: unknown[] }).positions).toHaveLength(1);
  });
});
