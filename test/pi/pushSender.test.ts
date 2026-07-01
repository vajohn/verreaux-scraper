import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import type { AccountStore, PushSubscriptionJSON } from "../../src/pi/syncStore.js";

// Controlled mock for vapid module
const mockSendNotification = vi.fn();
const mockIsPushConfigured = vi.fn(() => true);

vi.mock("../../src/pi/vapid.js", () => ({
  isPushConfigured: mockIsPushConfigured,
  webpush: {
    sendNotification: mockSendNotification,
  },
}));

// Import after vi.mock so mocks are in place
const { notifyNewSeries } = await import("../../src/pi/pushSender.js");

const SUB_B: PushSubscriptionJSON = {
  endpoint: "https://push.example.com/b",
  keys: { p256dh: "pB256dh", auth: "authB" },
};

const SUB_A: PushSubscriptionJSON = {
  endpoint: "https://push.example.com/a",
  keys: { p256dh: "pA256dh", auth: "authA" },
};

function makeStore(overrides?: Partial<AccountStore>): AccountStore {
  return {
    getAccountById: vi.fn().mockResolvedValue({
      id: "acc",
      username: "alice",
      passcodeHash: "hash",
      devices: [
        { id: "A", name: "OwnerPhone", tokenHash: "th-a", createdAt: "", lastSeenAt: "", pushSubscription: SUB_A },
        { id: "B", name: "OtherTablet", tokenHash: "th-b", createdAt: "", lastSeenAt: "", pushSubscription: SUB_B },
        { id: "C", name: "NoSubDevice", tokenHash: "th-c", createdAt: "", lastSeenAt: "" },
      ],
    }),
    setDevicePushSubscription: vi.fn().mockResolvedValue(undefined),
    // unused stubs to satisfy interface
    findAccountByUsername: vi.fn(),
    createAccount: vi.fn(),
    addDevice: vi.fn(),
    removeDevice: vi.fn(),
    findByDeviceTokenHash: vi.fn(),
    touchDevice: vi.fn(),
    upsertPositionMerged: vi.fn(),
    getPositionsSince: vi.fn(),
    ...overrides,
  } as unknown as AccountStore;
}

describe("notifyNewSeries", () => {
  beforeEach(() => {
    mockSendNotification.mockReset();
    mockIsPushConfigured.mockReset();
    mockIsPushConfigured.mockReturnValue(true);
  });

  it("sends to non-owner devices with a subscription, skips owner and no-sub device", async () => {
    mockSendNotification.mockResolvedValue({ statusCode: 201 });

    const store = makeStore();
    await notifyNewSeries(store, "acc", "A", "https://x/s");

    // Only device B should receive a push (not A=owner, not C=no sub)
    expect(mockSendNotification).toHaveBeenCalledTimes(1);

    const [subArg, payloadArg] = mockSendNotification.mock.calls[0] as [unknown, string];
    // Payload contains the required fields
    expect(payloadArg).toContain("new-series");
    expect(payloadArg).toContain("https://x/s");

    // Subscription passed should be device B's
    expect(subArg).toMatchObject({ endpoint: SUB_B.endpoint });
  });

  it("prunes subscription on 410 error by calling setDevicePushSubscription with null", async () => {
    mockSendNotification.mockRejectedValue({ statusCode: 410 });

    const store = makeStore();
    await notifyNewSeries(store, "acc", "A", "https://x/s");

    expect(store.setDevicePushSubscription).toHaveBeenCalledWith("acc", "B", null);
    // Must not throw
  });

  it("prunes subscription on 404 error", async () => {
    mockSendNotification.mockRejectedValue({ statusCode: 404 });

    const store = makeStore();
    await notifyNewSeries(store, "acc", "A", "https://x/s");

    expect(store.setDevicePushSubscription).toHaveBeenCalledWith("acc", "B", null);
  });

  it("does not prune on non-expiry errors", async () => {
    mockSendNotification.mockRejectedValue({ statusCode: 500 });

    const store = makeStore();
    await notifyNewSeries(store, "acc", "A", "https://x/s");

    expect(store.setDevicePushSubscription).not.toHaveBeenCalled();
  });

  it("is a no-op when push is not configured", async () => {
    mockIsPushConfigured.mockReturnValue(false);

    const store = makeStore();
    await notifyNewSeries(store, "acc", "A", "https://x/s");

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(store.getAccountById).not.toHaveBeenCalled();
  });

  it("is a no-op when the account does not exist", async () => {
    const store = makeStore({
      getAccountById: vi.fn().mockResolvedValue(null),
    });

    await notifyNewSeries(store, "missing", "A", "https://x/s");

    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});
