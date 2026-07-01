import type { Pool } from "pg";
import { mergePosition, type Position, type StoredPosition, type MergeResult } from "./positionMerge.js";
import type { Account, AccountStore, Device, PositionRow, PushSubscriptionJSON } from "./syncStore.js";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  passcode_hash TEXT NOT NULL,
  devices       JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_positions (
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_url      TEXT NOT NULL,
  chapter_order   NUMERIC NOT NULL,
  page_index      INTEGER NOT NULL,
  owner_device    TEXT NOT NULL,
  manually_marked BOOLEAN NOT NULL DEFAULT false,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, source_url)
);
-- Containment lookups by device token hash (findByDeviceTokenHash).
CREATE INDEX IF NOT EXISTS accounts_devices_gin ON accounts USING gin (devices);
`;

interface AccountRow { id: string; username: string; passcode_hash: string; devices: Device[] }

function toAccount(r: AccountRow): Account {
  return { id: r.id, username: r.username, passcodeHash: r.passcode_hash, devices: r.devices ?? [] };
}

export class PgAccountStore implements AccountStore {
  constructor(private pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async findAccountByUsername(username: string): Promise<Account | null> {
    const r = await this.pool.query<AccountRow>("SELECT id, username, passcode_hash, devices FROM accounts WHERE username=$1", [username]);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }
  async getAccountById(accountId: string): Promise<Account | null> {
    const r = await this.pool.query<AccountRow>("SELECT id, username, passcode_hash, devices FROM accounts WHERE id=$1", [accountId]);
    return r.rows[0] ? toAccount(r.rows[0]) : null;
  }
  async createAccount(username: string, passcodeHash: string): Promise<Account> {
    const r = await this.pool.query<AccountRow>(
      "INSERT INTO accounts(username, passcode_hash) VALUES($1,$2) RETURNING id, username, passcode_hash, devices",
      [username, passcodeHash],
    );
    return toAccount(r.rows[0]!);
  }
  async addDevice(accountId: string, device: Device): Promise<void> {
    await this.pool.query(
      "UPDATE accounts SET devices = devices || $2::jsonb, updated_at=now() WHERE id=$1",
      [accountId, JSON.stringify([device])],
    );
  }
  async removeDevice(accountId: string, deviceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE accounts SET devices = (SELECT COALESCE(jsonb_agg(d),'[]'::jsonb) FROM jsonb_array_elements(devices) d WHERE d->>'id' <> $2), updated_at=now() WHERE id=$1`,
      [accountId, deviceId],
    );
  }
  async findByDeviceTokenHash(tokenHash: string): Promise<{ account: Account; device: Device } | null> {
    const r = await this.pool.query<AccountRow>(
      `SELECT id, username, passcode_hash, devices FROM accounts WHERE devices @> $1::jsonb`,
      [JSON.stringify([{ tokenHash }])],
    );
    const row = r.rows[0];
    if (!row) return null;
    const account = toAccount(row);
    const device = account.devices.find((d) => d.tokenHash === tokenHash);
    return device ? { account, device } : null;
  }
  async touchDevice(accountId: string, deviceId: string): Promise<void> {
    await this.pool.query(
      // lastSeenAt is written as an ISO-8601 UTC string to match the Device
      // interface + InMemoryAccountStore (now()::text would be a space-separated,
      // local-tz format). updated_at bumped to match addDevice/removeDevice.
      `UPDATE accounts SET devices = (SELECT jsonb_agg(CASE WHEN d->>'id'=$2 THEN jsonb_set(d,'{lastSeenAt}', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ELSE d END) FROM jsonb_array_elements(devices) d), updated_at=now() WHERE id=$1`,
      [accountId, deviceId],
    );
  }
  async setDevicePushSubscription(accountId: string, deviceId: string, sub: PushSubscriptionJSON | null): Promise<void> {
    if (sub !== null) {
      await this.pool.query(
        `UPDATE accounts SET devices = (SELECT jsonb_agg(CASE WHEN d->>'id'=$2 THEN jsonb_set(d,'{pushSubscription}', $3::jsonb) ELSE d END) FROM jsonb_array_elements(devices) d), updated_at=now() WHERE id=$1`,
        [accountId, deviceId, JSON.stringify(sub)],
      );
    } else {
      await this.pool.query(
        `UPDATE accounts SET devices = (SELECT jsonb_agg(CASE WHEN d->>'id'=$2 THEN (d - 'pushSubscription') ELSE d END) FROM jsonb_array_elements(devices) d), updated_at=now() WHERE id=$1`,
        [accountId, deviceId],
      );
    }
  }
  async upsertPositionMerged(accountId: string, sourceUrl: string, incoming: Position & { device: string }): Promise<MergeResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        "SELECT chapter_order, page_index, owner_device, manually_marked FROM reading_positions WHERE account_id=$1 AND source_url=$2 FOR UPDATE",
        [accountId, sourceUrl],
      );
      const current: StoredPosition | null = cur.rows[0]
        ? { chapterOrder: Number(cur.rows[0].chapter_order), pageIndex: cur.rows[0].page_index as number, ownerDevice: cur.rows[0].owner_device as string, manuallyMarked: cur.rows[0].manually_marked as boolean }
        : null;
      const result = mergePosition(current, incoming);
      if (result.changed) {
        await client.query(
          `INSERT INTO reading_positions(account_id, source_url, chapter_order, page_index, owner_device, manually_marked, updated_at)
           VALUES($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (account_id, source_url) DO UPDATE SET
             chapter_order=EXCLUDED.chapter_order, page_index=EXCLUDED.page_index,
             owner_device=EXCLUDED.owner_device, manually_marked=EXCLUDED.manually_marked, updated_at=now()`,
          [accountId, sourceUrl, result.value.chapterOrder, result.value.pageIndex, result.value.ownerDevice, result.value.manuallyMarked],
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async getPositionsSince(accountId: string, since: string | null): Promise<PositionRow[]> {
    const sql = since
      ? "SELECT source_url, chapter_order, page_index, owner_device, manually_marked, updated_at FROM reading_positions WHERE account_id=$1 AND updated_at > $2"
      : "SELECT source_url, chapter_order, page_index, owner_device, manually_marked, updated_at FROM reading_positions WHERE account_id=$1";
    const params = since ? [accountId, since] : [accountId];
    const r = await this.pool.query(sql, params);
    return r.rows.map((row: Record<string, unknown>) => ({
      sourceUrl: row["source_url"] as string,
      chapterOrder: Number(row["chapter_order"]),
      pageIndex: row["page_index"] as number,
      ownerDevice: row["owner_device"] as string,
      manuallyMarked: row["manually_marked"] as boolean,
      updatedAt: typeof row["updated_at"] === "string" ? row["updated_at"] : new Date(row["updated_at"] as string | number | Date).toISOString(),
    }));
  }
}
