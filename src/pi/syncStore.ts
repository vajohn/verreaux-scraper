import { mergePosition, type Position, type StoredPosition, type MergeResult } from "./positionMerge.js";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  pushSubscription?: PushSubscriptionJSON;
}

export interface Account {
  id: string;
  username: string;
  passcodeHash: string;
  devices: Device[];
}

export interface PositionRow extends StoredPosition {
  sourceUrl: string;
  updatedAt: string;
}

export interface AccountStore {
  findAccountByUsername(username: string): Promise<Account | null>;
  getAccountById(accountId: string): Promise<Account | null>;
  createAccount(username: string, passcodeHash: string): Promise<Account>;
  addDevice(accountId: string, device: Device): Promise<void>;
  removeDevice(accountId: string, deviceId: string): Promise<void>;
  findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null>;
  touchDevice(accountId: string, deviceId: string): Promise<void>;
  setDevicePushSubscription(accountId: string, deviceId: string, sub: PushSubscriptionJSON | null): Promise<void>;
  upsertPositionMerged(
    accountId: string,
    sourceUrl: string,
    incoming: Position & { device: string },
  ): Promise<MergeResult>;
  getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]>;
}

/** Test/double implementation. The Pi uses PgAccountStore. */
export class InMemoryAccountStore implements AccountStore {
  private accounts = new Map<string, Account>();
  private positions = new Map<string, Map<string, PositionRow>>();
  private seq = 0;
  constructor(private now: () => string = () => new Date().toISOString()) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  async findAccountByUsername(username: string): Promise<Account | null> {
    for (const a of this.accounts.values()) if (a.username === username) return a;
    return null;
  }
  async getAccountById(accountId: string): Promise<Account | null> {
    return this.accounts.get(accountId) ?? null;
  }
  async createAccount(username: string, passcodeHash: string): Promise<Account> {
    const acc: Account = { id: this.id("acc"), username, passcodeHash, devices: [] };
    this.accounts.set(acc.id, acc);
    return acc;
  }
  async addDevice(accountId: string, device: Device): Promise<void> {
    this.accounts.get(accountId)?.devices.push(device);
  }
  async removeDevice(accountId: string, deviceId: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) a.devices = a.devices.filter((d) => d.id !== deviceId);
  }
  async findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null> {
    for (const a of this.accounts.values()) {
      const d = a.devices.find((x) => x.tokenHash === tokenHash);
      if (d) return { account: a, device: d };
    }
    return null;
  }
  async touchDevice(accountId: string, deviceId: string): Promise<void> {
    const d = this.accounts.get(accountId)?.devices.find((x) => x.id === deviceId);
    if (d) d.lastSeenAt = this.now();
  }
  async setDevicePushSubscription(accountId: string, deviceId: string, sub: PushSubscriptionJSON | null): Promise<void> {
    const d = this.accounts.get(accountId)?.devices.find((x) => x.id === deviceId);
    if (!d) return;
    if (sub !== null) {
      d.pushSubscription = sub;
    } else {
      delete d.pushSubscription;
    }
  }
  async upsertPositionMerged(
    accountId: string,
    sourceUrl: string,
    incoming: Position & { device: string },
  ): Promise<MergeResult> {
    let byUrl = this.positions.get(accountId);
    if (!byUrl) {
      byUrl = new Map();
      this.positions.set(accountId, byUrl);
    }
    const existing = byUrl.get(sourceUrl);
    const current: StoredPosition | null = existing
      ? { chapterOrder: existing.chapterOrder, pageIndex: existing.pageIndex, manuallyMarked: existing.manuallyMarked, ownerDevice: existing.ownerDevice }
      : null;
    const result = mergePosition(current, incoming);
    if (result.changed) {
      byUrl.set(sourceUrl, { ...result.value, sourceUrl, updatedAt: this.now() });
    }
    return result;
  }
  async getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]> {
    const rows = [...(this.positions.get(accountId)?.values() ?? [])];
    return since ? rows.filter((r) => r.updatedAt > since) : rows;
  }
}
