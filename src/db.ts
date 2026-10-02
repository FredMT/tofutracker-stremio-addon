import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "./diff.ts";
import type { ClientEvent } from "./events.ts";
import type { ItemSnapshot } from "./library.ts";

export type AccountStatus = "ok" | "needs_stremio_signin" | "needs_tofutracker_relink";

export type Account = {
  id: string;
  createdAt: number;
  tofuTokenEnc: string;
  tofuUsername: string | null;
  tofuConnectionId: string | null;
  stremioAuthEnc: string;
  stremioUserHash: string | null;
  status: AccountStatus;
  statusAt: number;
  baselined: boolean;
  activeUntil: number;
  nextPollAt: number;
  lastPollAt: number | null;
  sendBlockedUntil: number;
  failCount: number;
};

export type SetupState = "waiting" | "linked" | "expired" | "denied";

export type Setup = {
  id: string;
  createdAt: number;
  expiresAt: number;
  accountId: string | null;
  pairDeviceEnc: string | null;
  pairUserCode: string | null;
  pairUrl: string | null;
  pairState: SetupState | null;
  pairExpiresAt: number | null;
  pairIntervalMs: number;
  pairNextPollAt: number;
  tofuTokenEnc: string | null;
  tofuConnectionId: string | null;
  tofuUsername: string | null;
  linkCodeEnc: string | null;
  linkUrl: string | null;
  linkQr: string | null;
  linkState: SetupState | null;
  linkExpiresAt: number | null;
  linkNextPollAt: number;
  stremioAuthEnc: string | null;
  stremioUserHash: string | null;
};

export type OutboxRow = { id: number; accountId: string; event: ClientEvent; attempts: number };

export type StoredItem = { snapshot: ItemSnapshot; session: Session | null; mtime: number };

const SCHEMA = `
create table if not exists account (
  id text primary key,
  created_at integer not null,
  tofu_token_enc text not null,
  tofu_username text,
  tofu_connection_id text,
  stremio_auth_enc text not null,
  stremio_user_hash text,
  status text not null default 'ok',
  status_at integer not null,
  baselined integer not null default 0,
  active_until integer not null default 0,
  next_poll_at integer not null default 0,
  last_poll_at integer,
  send_blocked_until integer not null default 0,
  fail_count integer not null default 0
);
create index if not exists account_user on account (stremio_user_hash);
create index if not exists account_due on account (next_poll_at) where status = 'ok';

create table if not exists item_state (
  account_id text not null references account (id) on delete cascade,
  item_id text not null,
  mtime integer not null,
  snapshot text not null,
  session text,
  primary key (account_id, item_id)
) without rowid;
create index if not exists item_state_session on item_state (account_id) where session is not null;

create table if not exists outbox (
  id integer primary key autoincrement,
  account_id text not null references account (id) on delete cascade,
  event text not null,
  created_at integer not null,
  attempts integer not null default 0,
  next_attempt_at integer not null
);
create index if not exists outbox_due on outbox (account_id, next_attempt_at);

create table if not exists setup (
  id text primary key,
  created_at integer not null,
  expires_at integer not null,
  account_id text,
  pair_device_enc text,
  pair_user_code text,
  pair_url text,
  pair_state text,
  pair_expires_at integer,
  pair_interval_ms integer not null default 3000,
  pair_next_poll_at integer not null default 0,
  tofu_token_enc text,
  tofu_connection_id text,
  tofu_username text,
  link_code_enc text,
  link_url text,
  link_qr text,
  link_state text,
  link_expires_at integer,
  link_next_poll_at integer not null default 0,
  stremio_auth_enc text,
  stremio_user_hash text
);
`;

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const toAccount = (r: Row): Account => ({
  id: String(r["id"]),
  createdAt: num(r["created_at"]),
  tofuTokenEnc: String(r["tofu_token_enc"]),
  tofuUsername: strOrNull(r["tofu_username"]),
  tofuConnectionId: strOrNull(r["tofu_connection_id"]),
  stremioAuthEnc: String(r["stremio_auth_enc"]),
  stremioUserHash: strOrNull(r["stremio_user_hash"]),
  status: String(r["status"]) as AccountStatus,
  statusAt: num(r["status_at"]),
  baselined: num(r["baselined"]) === 1,
  activeUntil: num(r["active_until"]),
  nextPollAt: num(r["next_poll_at"]),
  lastPollAt: numOrNull(r["last_poll_at"]),
  sendBlockedUntil: num(r["send_blocked_until"]),
  failCount: num(r["fail_count"]),
});

const toSetup = (r: Row): Setup => ({
  id: String(r["id"]),
  createdAt: num(r["created_at"]),
  expiresAt: num(r["expires_at"]),
  accountId: strOrNull(r["account_id"]),
  pairDeviceEnc: strOrNull(r["pair_device_enc"]),
  pairUserCode: strOrNull(r["pair_user_code"]),
  pairUrl: strOrNull(r["pair_url"]),
  pairState: strOrNull(r["pair_state"]) as SetupState | null,
  pairExpiresAt: numOrNull(r["pair_expires_at"]),
  pairIntervalMs: num(r["pair_interval_ms"]),
  pairNextPollAt: num(r["pair_next_poll_at"]),
  tofuTokenEnc: strOrNull(r["tofu_token_enc"]),
  tofuConnectionId: strOrNull(r["tofu_connection_id"]),
  tofuUsername: strOrNull(r["tofu_username"]),
  linkCodeEnc: strOrNull(r["link_code_enc"]),
  linkUrl: strOrNull(r["link_url"]),
  linkQr: strOrNull(r["link_qr"]),
  linkState: strOrNull(r["link_state"]) as SetupState | null,
  linkExpiresAt: numOrNull(r["link_expires_at"]),
  linkNextPollAt: num(r["link_next_poll_at"]),
  stremioAuthEnc: strOrNull(r["stremio_auth_enc"]),
  stremioUserHash: strOrNull(r["stremio_user_hash"]),
});

/** Columns of `setup` that `updateSetup` may write, by their TypeScript names. */
const SETUP_COLUMNS: Record<keyof Omit<Setup, "id" | "createdAt">, string> = {
  expiresAt: "expires_at",
  accountId: "account_id",
  pairDeviceEnc: "pair_device_enc",
  pairUserCode: "pair_user_code",
  pairUrl: "pair_url",
  pairState: "pair_state",
  pairExpiresAt: "pair_expires_at",
  pairIntervalMs: "pair_interval_ms",
  pairNextPollAt: "pair_next_poll_at",
  tofuTokenEnc: "tofu_token_enc",
  tofuConnectionId: "tofu_connection_id",
  tofuUsername: "tofu_username",
  linkCodeEnc: "link_code_enc",
  linkUrl: "link_url",
  linkQr: "link_qr",
  linkState: "link_state",
  linkExpiresAt: "link_expires_at",
  linkNextPollAt: "link_next_poll_at",
  stremioAuthEnc: "stremio_auth_enc",
  stremioUserHash: "stremio_user_hash",
};

const OUTBOX_PER_ACCOUNT = 500;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true });
    return new Store(join(dataDir, "stremio-addon.sqlite"));
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` atomically; nothing it wrote survives if it throws. */
  transaction<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = fn();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  ping(): boolean {
    return this.db.prepare("select 1 as ok").get()?.["ok"] === 1;
  }

  // accounts

  insertAccount(a: Pick<Account, "id" | "tofuTokenEnc" | "tofuUsername" | "tofuConnectionId" | "stremioAuthEnc" | "stremioUserHash">, now: number): void {
    this.db
      .prepare(
        `insert into account (id, created_at, tofu_token_enc, tofu_username, tofu_connection_id, stremio_auth_enc, stremio_user_hash, status, status_at, next_poll_at)
         values (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
      )
      .run(a.id, now, a.tofuTokenEnc, a.tofuUsername, a.tofuConnectionId, a.stremioAuthEnc, a.stremioUserHash, now, now);
  }

  /** The account already linked to this Stremio user, if any. */
  findAccountByStremioUser(hash: string): Account | null {
    const row = this.db.prepare("select * from account where stremio_user_hash = ? order by created_at limit 1").get(hash);
    return row ? toAccount(row) : null;
  }

  getAccount(id: string): Account | null {
    const row = this.db.prepare("select * from account where id = ?").get(id);
    return row ? toAccount(row) : null;
  }

  deleteAccount(id: string): void {
    this.db.prepare("delete from account where id = ?").run(id);
  }

  countAccounts(): number {
    return num(this.db.prepare("select count(*) as n from account").get()?.["n"]);
  }

  /** Replace credentials after a re-link; polling resumes and the library is re-baselined. */
  updateCredentials(
    id: string,
    changes: { tofuTokenEnc?: string; tofuUsername?: string | null; tofuConnectionId?: string | null; stremioAuthEnc?: string; stremioUserHash?: string | null; keepLibraryState?: boolean },
    now: number,
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (changes.tofuTokenEnc !== undefined) {
      set("tofu_token_enc", changes.tofuTokenEnc);
      set("tofu_username", changes.tofuUsername ?? null);
      set("tofu_connection_id", changes.tofuConnectionId ?? null);
    }
    if (changes.stremioAuthEnc !== undefined) {
      set("stremio_auth_enc", changes.stremioAuthEnc);
      if (changes.stremioUserHash !== undefined) set("stremio_user_hash", changes.stremioUserHash);
      // A different Stremio login may be a different library: forget what we knew.
      // The same Stremio user signing in again keeps their state, so nothing is missed or repeated.
      if (!changes.keepLibraryState) {
        this.db.prepare("delete from item_state where account_id = ?").run(id);
        set("baselined", 0);
      }
    }
    set("status", "ok");
    set("status_at", now);
    set("next_poll_at", now);
    set("fail_count", 0);
    set("send_blocked_until", 0);
    this.db.prepare(`update account set ${sets.join(", ")} where id = ?`).run(...values, id);
  }

  setStatus(id: string, status: AccountStatus, now: number): void {
    this.db.prepare("update account set status = ?, status_at = ? where id = ?").run(status, now, id);
    if (status === "needs_tofutracker_relink") this.db.prepare("delete from outbox where account_id = ?").run(id);
  }

  /** Accounts whose next poll is due, oldest first. */
  dueAccounts(now: number, limit: number): Account[] {
    return this.db
      .prepare("select * from account where status = 'ok' and next_poll_at <= ? order by next_poll_at limit ?")
      .all(now, limit)
      .map(toAccount);
  }

  schedule(id: string, fields: { nextPollAt: number; activeUntil?: number; lastPollAt?: number; failCount?: number; baselined?: boolean; sendBlockedUntil?: number }): void {
    this.db
      .prepare(
        `update account set next_poll_at = ?,
           active_until = coalesce(?, active_until),
           last_poll_at = coalesce(?, last_poll_at),
           fail_count = coalesce(?, fail_count),
           baselined = coalesce(?, baselined),
           send_blocked_until = coalesce(?, send_blocked_until)
         where id = ?`,
      )
      .run(fields.nextPollAt, fields.activeUntil ?? null, fields.lastPollAt ?? null, fields.failCount ?? null, fields.baselined === undefined ? null : fields.baselined ? 1 : 0, fields.sendBlockedUntil ?? null, id);
  }

  /** A subtitles ping: poll soon and keep polling fast for `windowMs`. Returns false for an unknown or paused account. */
  wake(id: string, now: number, windowMs: number, minGapMs: number): boolean {
    const account = this.getAccount(id);
    if (!account || account.status !== "ok") return false;
    const earliest = (account.lastPollAt ?? 0) + minGapMs;
    this.db
      .prepare("update account set active_until = max(active_until, ?), next_poll_at = min(next_poll_at, ?) where id = ?")
      .run(now + windowMs, Math.max(now, earliest), id);
    return true;
  }

  // library state

  itemMtimes(accountId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.db.prepare("select item_id, mtime from item_state where account_id = ?").all(accountId)) {
      out.set(String(row["item_id"]), num(row["mtime"]));
    }
    return out;
  }

  getItem(accountId: string, itemId: string): StoredItem | null {
    const row = this.db.prepare("select mtime, snapshot, session from item_state where account_id = ? and item_id = ?").get(accountId, itemId);
    return row ? parseStoredItem(row) : null;
  }

  putItem(accountId: string, itemId: string, item: StoredItem): void {
    this.db
      .prepare(
        `insert into item_state (account_id, item_id, mtime, snapshot, session) values (?, ?, ?, ?, ?)
         on conflict (account_id, item_id) do update set mtime = excluded.mtime, snapshot = excluded.snapshot, session = excluded.session`,
      )
      .run(accountId, itemId, item.mtime, JSON.stringify(item.snapshot), item.session ? JSON.stringify(item.session) : null);
  }

  setSession(accountId: string, itemId: string, session: Session | null): void {
    this.db
      .prepare("update item_state set session = ? where account_id = ? and item_id = ?")
      .run(session ? JSON.stringify(session) : null, accountId, itemId);
  }

  /** Items with a play in progress, as (item id, snapshot, session). */
  activeSessions(accountId: string): { itemId: string; session: Session }[] {
    const out: { itemId: string; session: Session }[] = [];
    for (const row of this.db.prepare("select item_id, session from item_state where account_id = ? and session is not null").all(accountId)) {
      const session = parseJson<Session>(row["session"]);
      if (session) out.push({ itemId: String(row["item_id"]), session });
    }
    return out;
  }

  // outbox: `watched` events that could not be delivered

  enqueue(accountId: string, events: ClientEvent[], now: number): void {
    const insert = this.db.prepare("insert into outbox (account_id, event, created_at, next_attempt_at) values (?, ?, ?, ?)");
    for (const event of events) insert.run(accountId, JSON.stringify(event), now, now);
    this.db
      .prepare(
        `delete from outbox where account_id = ? and id not in
           (select id from outbox where account_id = ? order by id desc limit ?)`,
      )
      .run(accountId, accountId, OUTBOX_PER_ACCOUNT);
  }

  outboxDue(accountId: string, now: number, limit: number): OutboxRow[] {
    const rows: OutboxRow[] = [];
    for (const row of this.db
      .prepare("select id, account_id, event, attempts from outbox where account_id = ? and next_attempt_at <= ? order by id limit ?")
      .all(accountId, now, limit)) {
      const event = parseJson<ClientEvent>(row["event"]);
      if (event) rows.push({ id: num(row["id"]), accountId, event, attempts: num(row["attempts"]) });
    }
    return rows;
  }

  outboxDelete(ids: number[]): void {
    const del = this.db.prepare("delete from outbox where id = ?");
    for (const id of ids) del.run(id);
  }

  outboxBackoff(ids: number[], nextAttemptAt: number): void {
    const upd = this.db.prepare("update outbox set attempts = attempts + 1, next_attempt_at = ? where id = ?");
    for (const id of ids) upd.run(nextAttemptAt, id);
  }

  outboxCount(accountId: string): number {
    return num(this.db.prepare("select count(*) as n from outbox where account_id = ?").get(accountId)?.["n"]);
  }

  // setup (the configure flow, before an account exists)

  insertSetup(id: string, accountId: string | null, now: number, ttlMs: number): void {
    this.db.prepare("insert into setup (id, created_at, expires_at, account_id) values (?, ?, ?, ?)").run(id, now, now + ttlMs, accountId);
  }

  getSetup(id: string, now: number): Setup | null {
    const row = this.db.prepare("select * from setup where id = ? and expires_at > ?").get(id, now);
    return row ? toSetup(row) : null;
  }

  updateSetup(id: string, changes: Partial<Omit<Setup, "id" | "createdAt">>): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const column = SETUP_COLUMNS[key as keyof typeof SETUP_COLUMNS];
      if (!column) throw new Error(`unknown setup field ${key}`);
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length > 0) this.db.prepare(`update setup set ${sets.join(", ")} where id = ?`).run(...values, id);
  }

  deleteSetup(id: string): void {
    this.db.prepare("delete from setup where id = ?").run(id);
  }

  prune(now: number, outboxMaxAgeMs: number): void {
    this.db.prepare("delete from setup where expires_at <= ?").run(now);
    this.db.prepare("delete from outbox where created_at < ?").run(now - outboxMaxAgeMs);
  }
}

const parseJson = <T>(raw: unknown): T | null => {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const parseStoredItem = (row: Row): StoredItem | null => {
  const snapshot = parseJson<ItemSnapshot>(row["snapshot"]);
  if (!snapshot) return null;
  return { snapshot, session: parseJson<Session>(row["session"]), mtime: num(row["mtime"]) };
};
