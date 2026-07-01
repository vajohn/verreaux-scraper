import { webpush, isPushConfigured } from "./vapid.js";
import type { AccountStore } from "./syncStore.js";

export async function notifyNewSeries(
  store: AccountStore,
  accountId: string,
  ownerDeviceId: string,
  sourceUrl: string,
): Promise<void> {
  if (!isPushConfigured()) return;

  const account = await store.getAccountById(accountId);
  if (!account) return;

  const payload = JSON.stringify({ type: "new-series", sourceUrl });

  await Promise.allSettled(
    account.devices
      .filter((d) => d.id !== ownerDeviceId && d.pushSubscription != null)
      .map(async (d) => {
        try {
          await webpush.sendNotification(
            d.pushSubscription as unknown as import("web-push").PushSubscription,
            payload,
          );
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await store.setDevicePushSubscription(accountId, d.id, null);
          }
        }
      }),
  );
}
