import type { PollTuning } from "./config.ts";
import { aad, open, type Keys } from "./crypto.ts";
import type { Account, Store } from "./db.ts";
import { diffItem, tickSession, type Session } from "./diff.ts";
import type { ClientEvent, ClientInfo } from "./events.ts";
import { EMPTY_SNAPSHOT, type LibraryItem } from "./library.ts";
import type { Logger } from "./log.ts";
import type { OutboxRow } from "./db.ts";
import type { ScrobblerClient } from "./scrobbler-client.ts";
import { StremioError, type StremioApi } from "./stremio-api.ts";

export type PollerDeps = {
  store: Store;
  stremio: StremioApi;
  scrobbler: ScrobblerClient;
  keys: Keys;
  tuning: PollTuning;
  client: ClientInfo;
  log: Logger;
  now?: () => number;
  newSessionId?: (accountId: string, videoId: string, startedAt: number) => string;
};

const TICK_MS = 5_000;
const PRUNE_MS = 3_600_000;
const CONCURRENCY = 4;
const SEND_BATCHES_PER_DRAIN = 10;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Non-`watched` events (start/progress/pause/stop) are dropped when they cannot be delivered soon. */
const TRANSIENT_MAX_ATTEMPTS = 3;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
const SEND_BACKOFF_BASE_MS = 60_000;
const SEND_BACKOFF_MAX_MS = 3_600_000;

export class Poller {
  private readonly deps: PollerDeps;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private running: Promise<void> = Promise.resolve();

  constructor(deps: PollerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.pruneTimer = setInterval(() => this.deps.store.prune(this.now(), OUTBOX_MAX_AGE_MS), PRUNE_MS);
    this.timer.unref();
    this.pruneTimer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = this.pruneTimer = null;
    await this.running;
  }

  /** A subtitles request arrived for this account: poll it soon and keep polling fast for a while. */
  wake(accountId: string): void {
    const { store, tuning } = this.deps;
    if (store.wake(accountId, this.now(), tuning.activeWindowMs, tuning.minGapMs)) void this.tick();
  }

  /** Poll every account that is due. Re-entrant calls while a tick runs are ignored. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.running = (async () => {
      try {
        const now = this.now();
        const due = this.deps.store.dueAccounts(now, 100).filter((a) => !this.inFlight.has(a.id));
        // Claim them so a crash or a slow poll does not make the next tick start a second one.
        for (const account of due) this.deps.store.schedule(account.id, { nextPollAt: now + 60_000 });
        const queue = [...due];
        const worker = async (): Promise<void> => {
          for (let account = queue.shift(); account; account = queue.shift()) await this.pollAccount(account.id);
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      } catch (error) {
        this.deps.log.error("tick failed", { error });
      } finally {
        this.ticking = false;
      }
    })();
    await this.running;
  }

  async pollAccount(accountId: string): Promise<void> {
    if (this.inFlight.has(accountId)) return;
    this.inFlight.add(accountId);
    try {
      const account = this.deps.store.getAccount(accountId);
      if (account?.status === "ok") await this.run(account);
    } catch (error) {
      this.deps.log.error("poll failed", { account: accountId.slice(0, 6), error });
      this.backoff(accountId, this.deps.store.getAccount(accountId)?.failCount ?? 0);
    } finally {
      this.inFlight.delete(accountId);
    }
  }

  private async run(account: Account): Promise<void> {
    const { store, stremio, tuning, log } = this.deps;
    const now = this.now();

    let authKey: string;
    try {
      authKey = open(this.deps.keys, account.stremioAuthEnc, aad(account.id, "stremio_auth"));
    } catch {
      log.error("cannot decrypt the stored Stremio credential (was STREMIO_CREDS_KEY changed?)", { account: account.id.slice(0, 6) });
      store.setStatus(account.id, "needs_stremio_signin", now);
      return;
    }

    let items: LibraryItem[];
    let meta: Map<string, number>;
    let changed: string[];
    try {
      meta = await stremio.libraryMeta(authKey);
      const known = store.itemMtimes(account.id);
      changed = [...meta].filter(([id, mtime]) => known.get(id) !== mtime).map(([id]) => id);
      items = changed.length > 0 ? await stremio.libraryGet(authKey, changed) : [];
    } catch (error) {
      this.onStremioError(account, error);
      return;
    }

    const events: ClientEvent[] = [];
    store.transaction(() => {
      const seen = new Set<string>();
      for (const item of items) {
        seen.add(item.id);
        const mtime = meta.get(item.id) ?? item.mtime;
        if (!account.baselined) {
          // First poll: remember where everything is, report nothing.
          store.putItem(account.id, item.id, { snapshot: item.snapshot, session: null, mtime });
          continue;
        }
        const stored = store.getItem(account.id, item.id);
        const result = diffItem({
          prev: stored?.snapshot ?? null,
          cur: item.snapshot,
          mtime: item.mtime,
          session: stored?.session ?? null,
          now,
          newSessionId: (videoId, startedAt) => this.sessionId(account.id, videoId, startedAt),
        });
        if (result.dropped > 0) log.warn("watched events dropped by the per-item cap", { account: account.id.slice(0, 6), dropped: result.dropped });
        events.push(...result.events);
        store.putItem(account.id, item.id, { snapshot: item.snapshot, session: result.session, mtime });
      }
      // Ids Stremio lists that we could not read: remember their mtime so they are not refetched every poll.
      for (const id of changed) {
        if (seen.has(id)) continue;
        const stored = store.getItem(account.id, id);
        store.putItem(account.id, id, { snapshot: stored?.snapshot ?? EMPTY_SNAPSHOT, session: stored?.session ?? null, mtime: meta.get(id) ?? 0 });
      }
      if (account.baselined) {
        for (const { itemId, session } of store.activeSessions(account.id)) {
          if (seen.has(itemId)) continue; // diffItem just handled this item
          const ticked = tickSession(session, now, tuning);
          events.push(...ticked.events);
          if (ticked.session !== session) store.setSession(account.id, itemId, ticked.session);
        }
        store.enqueue(account.id, events, now);
      }
    });
    const live = account.baselined ? store.activeSessions(account.id).length : 0;

    if (!account.baselined) log.info("baseline recorded", { account: account.id.slice(0, 6), items: items.length });
    else if (events.length > 0) log.info("events queued", { account: account.id.slice(0, 6), events: events.length });

    await this.drain(account.id);

    const activeUntil = account.baselined && items.length > 0 ? Math.max(account.activeUntil, now + tuning.activeWindowMs) : account.activeUntil;
    const fast = now < activeUntil || live > 0;
    store.schedule(account.id, {
      nextPollAt: now + (fast ? tuning.activeIntervalMs : tuning.baselineIntervalMs),
      activeUntil,
      lastPollAt: now,
      failCount: 0,
      baselined: true,
    });
  }

  private onStremioError(account: Account, error: unknown): void {
    const { store, log } = this.deps;
    if (error instanceof StremioError && error.kind === "session") {
      log.warn("Stremio no longer accepts the stored sign-in", { account: account.id.slice(0, 6) });
      store.setStatus(account.id, "needs_stremio_signin", this.now());
      return;
    }
    log.warn("Stremio poll failed", { account: account.id.slice(0, 6), reason: error instanceof StremioError ? error.kind : "unexpected", error });
    this.backoff(account.id, account.failCount);
  }

  private backoff(accountId: string, failCount: number): void {
    const delay = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** failCount, FAILURE_BACKOFF_MAX_MS);
    this.deps.store.schedule(accountId, { nextPollAt: this.now() + delay, failCount: failCount + 1 });
  }

  private sessionId(accountId: string, videoId: string, startedAt: number): string {
    return this.deps.newSessionId?.(accountId, videoId, startedAt) ?? `stremio:${accountId.slice(0, 8)}:${videoId}:${Math.floor(startedAt / 1000)}`;
  }

  /** Send queued events in order. Stops at the first batch that has to be retried. */
  async drain(accountId: string): Promise<void> {
    const { store, keys, client, log } = this.deps;
    const account = store.getAccount(accountId);
    if (!account || account.status !== "ok") return;
    let token: string;
    try {
      token = open(keys, account.tofuTokenEnc, aad(account.id, "tofu_token"));
    } catch {
      log.error("cannot decrypt the stored TofuTracker token", { account: accountId.slice(0, 6) });
      store.setStatus(accountId, "needs_tofutracker_relink", this.now());
      return;
    }

    for (let batch = 0; batch < SEND_BATCHES_PER_DRAIN; batch++) {
      const now = this.now();
      if (now < (store.getAccount(accountId)?.sendBlockedUntil ?? 0)) return;
      const rows = store.outboxDue(accountId, now, 50);
      if (rows.length === 0) return;
      const outcome = await this.send(token, client, rows);
      if (outcome === "unauthorized") {
        log.warn("TofuTracker rejected the connection token; link again", { account: accountId.slice(0, 6) });
        store.setStatus(accountId, "needs_tofutracker_relink", this.now());
        return;
      }
      if (outcome === "retry") return;
    }
  }

  private async send(token: string, client: ClientInfo, rows: OutboxRow[]): Promise<"done" | "retry" | "unauthorized"> {
    const { store, scrobbler, log } = this.deps;
    const result = await scrobbler.postEvents(token, client, rows.map((r) => r.event));
    const ids = rows.map((r) => r.id);
    switch (result.kind) {
      case "accepted":
        store.outboxDelete(ids);
        return "done";
      case "unauthorized":
        return "unauthorized";
      case "rejected":
        log.warn("scrobbler rejected events; dropped", { status: result.status, events: rows.length });
        store.outboxDelete(ids);
        return "done";
      case "too_large": {
        if (rows.length === 1) {
          store.outboxDelete(ids);
          return "done";
        }
        const half = Math.ceil(rows.length / 2);
        const first = await this.send(token, client, rows.slice(0, half));
        return first === "done" ? this.send(token, client, rows.slice(half)) : first;
      }
      case "retry": {
        const now = this.now();
        const attempts = Math.max(...rows.map((r) => r.attempts));
        const delay = result.afterMs ?? Math.min(SEND_BACKOFF_BASE_MS * 2 ** attempts, SEND_BACKOFF_MAX_MS);
        // Progress ticks are not worth keeping; watched events must survive.
        const stale = rows.filter((r) => r.event.action !== "watched" && r.attempts + 1 >= TRANSIENT_MAX_ATTEMPTS).map((r) => r.id);
        store.outboxDelete(stale);
        store.outboxBackoff(ids.filter((id) => !stale.includes(id)), now + delay);
        const accountId = rows[0]?.accountId;
        if (accountId) store.schedule(accountId, { nextPollAt: store.getAccount(accountId)?.nextPollAt ?? now, sendBlockedUntil: now + delay });
        log.warn("scrobbler unavailable; will retry", { reason: result.reason, retryInMs: delay });
        return "retry";
      }
    }
  }
}

export type { Session };
