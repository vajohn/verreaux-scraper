import type { AccountStore, Account, Device } from "./syncStore.js";
import { hashPasscode, verifyPasscode } from "./passwords.js";
import { hashToken } from "./tokens.js";

export interface SyncDeps {
  store: AccountStore;
  /** Validate an OTP against the shared secret (wraps verifyTotp). */
  verifyOtp: (code: string) => boolean;
  now: () => string;
  newToken: () => string;
  newId: () => string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface PutPositionResult extends HandlerResult {
  /** True when this PUT created a position for a sourceUrl not previously tracked. */
  isNewSeries: boolean;
}

export interface DeviceContext {
  account: Account;
  device: Device;
}

export async function handleEnroll(
  input: { username: string; passcode: string; otp: string; deviceName: string },
  deps: SyncDeps,
): Promise<HandlerResult> {
  if (!deps.verifyOtp(input.otp)) return { status: 401, body: { error: "invalid authenticator code" } };
  if (!input.username || !input.passcode) return { status: 400, body: { error: "username and passcode required" } };

  let account = await deps.store.findAccountByUsername(input.username);
  if (account) {
    if (!verifyPasscode(input.passcode, account.passcodeHash)) {
      return { status: 401, body: { error: "invalid passcode" } };
    }
  } else {
    account = await deps.store.createAccount(input.username, hashPasscode(input.passcode));
  }

  const token = deps.newToken();
  const ts = deps.now();
  const device: Device = {
    id: deps.newId(),
    name: input.deviceName || "device",
    tokenHash: hashToken(token),
    createdAt: ts,
    lastSeenAt: ts,
  };
  await deps.store.addDevice(account.id, device);
  return { status: 201, body: { accountId: account.id, deviceId: device.id, deviceToken: token } };
}

/** Resolve a bearer token to {account, device}, or null. Touches last-seen. */
export async function resolveDevice(token: string | null, deps: SyncDeps): Promise<DeviceContext | null> {
  if (!token) return null;
  const found = await deps.store.findByDeviceTokenHash(hashToken(token));
  if (!found) return null;
  await deps.store.touchDevice(found.account.id, found.device.id);
  return found;
}

export async function handlePutPosition(
  ctx: DeviceContext,
  input: { sourceUrl: string; chapterOrder: number; pageIndex: number; manuallyMarked: boolean },
  deps: SyncDeps,
): Promise<PutPositionResult> {
  if (!input.sourceUrl || typeof input.chapterOrder !== "number" || Number.isNaN(input.chapterOrder) ||
      typeof input.pageIndex !== "number" || Number.isNaN(input.pageIndex)) {
    return { status: 400, body: { error: "sourceUrl, chapterOrder, pageIndex required" }, isNewSeries: false };
  }
  const result = await deps.store.upsertPositionMerged(ctx.account.id, input.sourceUrl, {
    chapterOrder: input.chapterOrder,
    pageIndex: input.pageIndex,
    manuallyMarked: !!input.manuallyMarked,
    device: ctx.device.id,
  });
  // Omit internal ownerDevice from the public response.
  return {
    status: 200,
    body: {
      sourceUrl: input.sourceUrl,
      chapterOrder: result.value.chapterOrder,
      pageIndex: result.value.pageIndex,
      manuallyMarked: result.value.manuallyMarked,
    },
    isNewSeries: result.isNewSeries,
  };
}

export async function handleGetPositions(
  ctx: DeviceContext,
  since: string | null,
  deps: SyncDeps,
): Promise<HandlerResult> {
  const rows = await deps.store.getPositionsSince(ctx.account.id, since);
  // Public shape: omit internal ownerDevice.
  const positions = rows.map((p) => ({
    sourceUrl: p.sourceUrl,
    chapterOrder: p.chapterOrder,
    pageIndex: p.pageIndex,
    manuallyMarked: p.manuallyMarked,
    updatedAt: p.updatedAt,
  }));
  return { status: 200, body: { positions } };
}
