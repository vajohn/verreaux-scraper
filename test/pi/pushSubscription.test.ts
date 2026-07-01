import { describe, it, expect } from "vitest";
import { InMemoryAccountStore, type PushSubscriptionJSON } from "../../src/pi/syncStore.js";

const FAKE_SUB: PushSubscriptionJSON = {
  endpoint: "https://fcm.googleapis.com/fcm/send/fake-endpoint",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlTieso1fhXqFmREHMHmYyFq_j-M8RM6RFfDExfSE",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

describe("InMemoryAccountStore – push subscription", () => {
  it("sets and retrieves a push subscription on a device", async () => {
    const store = new InMemoryAccountStore();
    const acc = await store.createAccount("alice", "hash");
    await store.addDevice(acc.id, {
      id: "dev-1",
      name: "Phone",
      tokenHash: "th-1",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    await store.setDevicePushSubscription(acc.id, "dev-1", FAKE_SUB);

    const found = await store.getAccountById(acc.id);
    expect(found).not.toBeNull();
    const device = found!.devices.find((d) => d.id === "dev-1");
    expect(device).toBeDefined();
    expect(device!.pushSubscription).toEqual(FAKE_SUB);
  });

  it("clears a push subscription when null is passed", async () => {
    const store = new InMemoryAccountStore();
    const acc = await store.createAccount("bob", "hash");
    await store.addDevice(acc.id, {
      id: "dev-2",
      name: "Tablet",
      tokenHash: "th-2",
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });

    await store.setDevicePushSubscription(acc.id, "dev-2", FAKE_SUB);
    // Confirm it was set
    let found = await store.getAccountById(acc.id);
    expect(found!.devices.find((d) => d.id === "dev-2")!.pushSubscription).toBeDefined();

    // Now clear it
    await store.setDevicePushSubscription(acc.id, "dev-2", null);
    found = await store.getAccountById(acc.id);
    expect(found!.devices.find((d) => d.id === "dev-2")!.pushSubscription).toBeUndefined();
  });

  it("is a no-op when the device does not exist", async () => {
    const store = new InMemoryAccountStore();
    const acc = await store.createAccount("carol", "hash");
    // Should not throw
    await expect(store.setDevicePushSubscription(acc.id, "nonexistent", FAKE_SUB)).resolves.toBeUndefined();
  });

  it("getAccountById returns null for unknown id", async () => {
    const store = new InMemoryAccountStore();
    const result = await store.getAccountById("does-not-exist");
    expect(result).toBeNull();
  });
});
