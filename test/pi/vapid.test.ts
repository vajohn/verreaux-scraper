import { describe, it, expect, vi, beforeEach } from "vitest";

describe("vapid", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // Reset module state between tests by re-importing with a fresh module
  });

  it("returns false and not configured when keys are absent", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    const { initVapid, isPushConfigured, getVapidPublicKey } = await import("../../src/pi/vapid.js");
    // Clear any prior configured state by calling with empty keys
    const result = initVapid();
    expect(result).toBe(false);
    expect(isPushConfigured()).toBe(false);
    expect(getVapidPublicKey()).toBeNull();
  });

  it("returns true and configured when valid VAPID keys are set", async () => {
    const { webpush } = await import("../../src/pi/vapid.js");
    const keys = webpush.generateVAPIDKeys();

    vi.stubEnv("VAPID_PUBLIC_KEY", keys.publicKey);
    vi.stubEnv("VAPID_PRIVATE_KEY", keys.privateKey);

    const { initVapid, isPushConfigured, getVapidPublicKey } = await import("../../src/pi/vapid.js");
    const result = initVapid();
    expect(result).toBe(true);
    expect(isPushConfigured()).toBe(true);
    expect(getVapidPublicKey()).toBe(keys.publicKey);
  });
});
