import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { CinemetaClient } from "../src/cinemeta.ts";
import { DEFAULT_POLL } from "../src/config.ts";
import { aad, deriveKeys, seal } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { silentLogger } from "../src/log.ts";
import { Poller } from "../src/poller.ts";
import { ScrobblerClient } from "../src/scrobbler-client.ts";
import { StremioApi } from "../src/stremio-api.ts";
import { BEBOP, FakeCinemeta, FakeScrobbler, FakeStremio, rawItem, watchedField } from "./helpers.ts";

const keys = deriveKeys(Buffer.alloc(32, 1));
const T0 = Date.parse("2026-10-02T14:00:00Z");
const ACCOUNT = "acct-1";

let stremio: FakeStremio;
let scrobbler: FakeScrobbler;
let store: Store;
let poller: Poller;
let clock: { t: number };

beforeEach(async () => {
  stremio = new FakeStremio();
  scrobbler = new FakeScrobbler();
  await Promise.all([stremio.start(), scrobbler.start()]);
  store = new Store(":memory:");
  clock = { t: T0 };
  poller = new Poller({
    store,
    stremio: new StremioApi({ apiUrl: stremio.url, linkUrl: stremio.url, timeoutMs: 2000 }),
    scrobbler: new ScrobblerClient(scrobbler.url, { timeoutMs: 2000 }),
    keys,
    tuning: DEFAULT_POLL,
    client: { name: "stremio-addon", version: "1.0.0", server: "Stremio" },
    log: silentLogger,
    now: () => clock.t,
  });
  store.insertAccount(
    {
      id: ACCOUNT,
      tofuTokenEnc: seal(keys, "tok-1", aad(ACCOUNT, "tofu_token")),
      tofuUsername: "kalugu",
      tofuConnectionId: "conn-1",
      stremioAuthEnc: seal(keys, "AK1", aad(ACCOUNT, "stremio_auth")),
      stremioUserHash: null,
    },
    T0,
  );
});

afterEach(async () => {
  await Promise.all([stremio.stop(), scrobbler.stop()]);
  store.close();
});

const advance = (ms: number): void => {
  clock.t += ms;
};
const actions = (): string[] => scrobbler.events.map((e) => `${e["action"]}${e["manual"] ? "!" : ""}`);
const account = () => store.getAccount(ACCOUNT);

const SHOW = "tt0903747";
const playing = (offset: number, extra: Record<string, unknown> = {}) => ({
  video_id: `${SHOW}:1:1`,
  timeOffset: offset,
  timeWatched: offset,
  overallTimeWatched: offset,
  duration: 2_700_000,
  ...extra,
});

test("the first poll records a baseline and sends nothing", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, { timesWatched: 3, flaggedWatched: 1 }));
  stremio.setItem(rawItem(SHOW, "series", T0 - 1000, playing(500_000, { timesWatched: 4, watched: watchedField(`${SHOW}:1:4`, 4, [0, 1, 2, 3]) })));
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 0);
  assert.equal(account()?.baselined, true);
  assert.equal(store.itemMtimes(ACCOUNT).size, 2);
  // A second poll with nothing changed still sends nothing and does not refetch items.
  stremio.calls.length = 0;
  advance(30_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 0);
  assert.deepEqual(stremio.calls.filter((c) => c.endsWith("datastoreGet")), []);
});

test("playing, pausing and stopping produce start, progress, pause and stop", async () => {
  stremio.setItem(rawItem(SHOW, "series", T0 - 1000, { video_id: `${SHOW}:1:1`, timeOffset: 1 }));
  await poller.pollAccount(ACCOUNT);

  advance(30_000);
  stremio.setItem(rawItem(SHOW, "series", clock.t - 1000, playing(90_000)));
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start"]);
  assert.equal(scrobbler.received[0]?.auth, "Bearer tok-1");
  assert.equal(scrobbler.events[0]?.["positionMs"], 90_000);

  advance(60_000);
  stremio.setItem(rawItem(SHOW, "series", clock.t - 1000, playing(180_000)));
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start", "progress"]);
  assert.equal(scrobbler.events[1]?.["sessionId"], scrobbler.events[0]?.["sessionId"]);

  advance(100_000); // idle, but not long enough to call it a pause
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start", "progress"]);

  advance(100_000);
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start", "progress", "pause"]);

  advance(10 * 60_000);
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start", "progress", "pause", "stop"]);
  assert.equal(store.activeSessions(ACCOUNT).length, 0);

  advance(15 * 60_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.events.length, 4);
});

test("a manual mark and a bitfield mark become manual watched events", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  stremio.setItem(rawItem(SHOW, "series", T0 - 1000, { video_id: `${SHOW}:1:1` }));
  await poller.pollAccount(ACCOUNT);

  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  stremio.setItem(rawItem(SHOW, "series", clock.t - 500, { video_id: `${SHOW}:1:1`, timesWatched: 2, watched: watchedField(`${SHOW}:1:2`, 2, [0, 1]) }));
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["watched!", "watched!", "watched!"]);
  const ids = scrobbler.events.map((e) => (e["item"] as { ids: { imdb: string } }).ids.imdb);
  assert.deepEqual(ids.sort(), ["tt0111161", SHOW, SHOW]);
  assert.ok(scrobbler.events.every((e) => String(e["sessionId"]).startsWith("manual:")));
});

test("a failed send keeps watched events and drops progress; the retry honours the backoff", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  stremio.setItem(rawItem(SHOW, "series", T0 - 1000, { video_id: `${SHOW}:1:1`, timeOffset: 1 }));
  await poller.pollAccount(ACCOUNT);

  scrobbler.eventsStatus = 500;
  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  stremio.setItem(rawItem(SHOW, "series", clock.t - 500, playing(90_000)));
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 1);
  assert.equal(store.outboxCount(ACCOUNT), 2);

  // Still inside the backoff window: no new request.
  advance(10_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 1);

  scrobbler.eventsStatus = 202;
  advance(5 * 60_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(store.outboxCount(ACCOUNT), 0);
  const delivered = scrobbler.received.at(-1)?.body["events"] as { action: string }[];
  assert.ok(delivered.some((e) => e.action === "watched"));
  assert.equal(account()?.status, "ok");
});

test("watched events survive a restart and keep their order", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  await poller.pollAccount(ACCOUNT);
  scrobbler.eventsStatus = 503;
  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  await poller.pollAccount(ACCOUNT);
  assert.equal(store.outboxCount(ACCOUNT), 1);

  // "Restart": a fresh poller over the same store.
  const reborn = new Poller({
    store,
    stremio: new StremioApi({ apiUrl: stremio.url, linkUrl: stremio.url }),
    scrobbler: new ScrobblerClient(scrobbler.url),
    keys,
    tuning: DEFAULT_POLL,
    client: { name: "stremio-addon", version: "1.0.0", server: "Stremio" },
    log: silentLogger,
    now: () => clock.t,
  });
  scrobbler.eventsStatus = 202;
  advance(10 * 60_000);
  await reborn.pollAccount(ACCOUNT);
  assert.equal(store.outboxCount(ACCOUNT), 0);
  assert.equal(actions().at(-1), "watched!");
});

test("429 with Retry-After blocks sending until then", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  await poller.pollAccount(ACCOUNT);
  scrobbler.eventsStatus = 429;
  scrobbler.retryAfter = "120";
  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 1);
  assert.equal(account()?.sendBlockedUntil, clock.t + 120_000);

  scrobbler.eventsStatus = 202;
  advance(60_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 1);
  advance(61_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, 2);
  assert.equal(store.outboxCount(ACCOUNT), 0);
});

test("a 401 from the scrobbler marks the account for re-link and stops sending", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  await poller.pollAccount(ACCOUNT);
  scrobbler.eventsStatus = 401;
  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.status, "needs_tofutracker_relink");
  assert.equal(store.outboxCount(ACCOUNT), 0);
  const requests = scrobbler.received.length;
  advance(30_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.received.length, requests);
});

test("a Stremio session error marks the account as needing a new sign-in", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  stremio.validKeys.clear();
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.status, "needs_stremio_signin");
  stremio.calls.length = 0;
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(stremio.calls, []);
});

test("a Stremio outage backs off without losing the account", async () => {
  stremio.down = true;
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.status, "ok");
  assert.equal(account()?.failCount, 1);
  assert.equal(account()?.nextPollAt, T0 + 30_000);
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.nextPollAt, T0 + 60_000);
});

test("tick polls due accounts; wake makes an idle account due within the minimum gap", async () => {
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  await poller.tick();
  assert.equal(account()?.baselined, true);
  assert.equal(account()?.nextPollAt, T0 + DEFAULT_POLL.baselineIntervalMs);

  advance(60_000);
  stremio.calls.length = 0;
  await poller.tick();
  assert.deepEqual(stremio.calls, []);

  poller.wake(ACCOUNT);
  await new Promise((resolve) => setImmediate(resolve));
  await poller.stop();
  assert.ok(stremio.calls.length > 0, "wake should poll");
  assert.equal(account()?.activeUntil, clock.t + DEFAULT_POLL.activeWindowMs);
});

test("a change keeps the account in fast-poll mode for 20 minutes", async () => {
  stremio.setItem(rawItem(SHOW, "series", T0 - 1000, { video_id: `${SHOW}:1:1`, timeOffset: 1 }));
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.nextPollAt, T0 + DEFAULT_POLL.baselineIntervalMs);
  advance(30_000);
  stremio.setItem(rawItem(SHOW, "series", clock.t - 500, playing(90_000)));
  await poller.pollAccount(ACCOUNT);
  assert.equal(account()?.nextPollAt, clock.t + DEFAULT_POLL.activeIntervalMs);
  assert.equal(account()?.activeUntil, clock.t + DEFAULT_POLL.activeWindowMs);
});

// Exact episode ids: events are enriched from Cinemeta as they are sent.

type SentItem = { ids: { imdb: string; tvdb: number | null; tmdb: number | null }; episodeIds: { tvdb: number | null }; season: number; episode: number; numbering: string };
const sentItems = (): SentItem[] => scrobbler.events.map((e) => e["item"] as SentItem);

const withCinemeta = async (setup: (fake: FakeCinemeta) => void = () => {}): Promise<FakeCinemeta> => {
  const cinemeta = new FakeCinemeta();
  cinemeta.series.set("tt0213338", BEBOP);
  setup(cinemeta);
  await cinemeta.start();
  poller = new Poller({
    store,
    stremio: new StremioApi({ apiUrl: stremio.url, linkUrl: stremio.url, timeoutMs: 2000 }),
    scrobbler: new ScrobblerClient(scrobbler.url, { timeoutMs: 2000 }),
    keys,
    tuning: DEFAULT_POLL,
    client: { name: "stremio-addon", version: "1.0.0", server: "Stremio" },
    log: silentLogger,
    cinemeta: new CinemetaClient({ baseUrl: cinemeta.url, timeoutMs: 1000, now: () => clock.t }),
    now: () => clock.t,
  });
  return cinemeta;
};

const BEBOP_ID = "tt0213338";
const bebop = (offset: number, extra: Record<string, unknown> = {}) => ({
  video_id: `${BEBOP_ID}:1:2`,
  timeOffset: offset,
  timeWatched: offset,
  overallTimeWatched: offset,
  duration: 1_440_000,
  ...extra,
});

test("every event of a play carries the exact ids and the same session id", async () => {
  const cinemeta = await withCinemeta();
  stremio.setItem(rawItem(BEBOP_ID, "series", T0 - 1000, { video_id: `${BEBOP_ID}:1:2`, timeOffset: 1 }));
  await poller.pollAccount(ACCOUNT);

  advance(30_000);
  stremio.setItem(rawItem(BEBOP_ID, "series", clock.t - 1000, bebop(90_000)));
  await poller.pollAccount(ACCOUNT);
  advance(60_000);
  stremio.setItem(rawItem(BEBOP_ID, "series", clock.t - 1000, bebop(1_100_000, { timesWatched: 1, flaggedWatched: 1 })));
  await poller.pollAccount(ACCOUNT);
  advance(200_000);
  await poller.pollAccount(ACCOUNT);
  advance(10 * 60_000);
  await poller.pollAccount(ACCOUNT);

  assert.deepEqual(actions(), ["start", "progress", "watched", "pause", "stop"]);
  assert.equal(new Set(scrobbler.events.map((e) => e["sessionId"])).size, 1);
  assert.match(String(scrobbler.events[0]?.["sessionId"]), /^stremio:acct-1:tt0213338:1:2:\d+$/);
  for (const item of sentItems()) {
    assert.equal(item.ids.imdb, BEBOP_ID);
    assert.equal(item.ids.tvdb, 76885);
    assert.equal(item.ids.tmdb, 30991);
    assert.equal(item.episodeIds.tvdb, 219121);
    assert.equal(item.season, 1);
    assert.equal(item.episode, 2);
    assert.equal(item.numbering, "imdb");
  }
  assert.equal(cinemeta.calls.length, 1, "one Cinemeta fetch for the whole play");
  await cinemeta.stop();
});

test("manual watched events are enriched too, and the outbox keeps the events as queued", async () => {
  const cinemeta = await withCinemeta();
  stremio.setItem(rawItem(BEBOP_ID, "series", T0 - 1000, { video_id: `${BEBOP_ID}:1:1` }));
  await poller.pollAccount(ACCOUNT);

  scrobbler.eventsStatus = 503;
  advance(30_000);
  stremio.setItem(rawItem(BEBOP_ID, "series", clock.t - 500, { video_id: `${BEBOP_ID}:1:1`, timesWatched: 2, watched: watchedField(`${BEBOP_ID}:1:2`, 2, [0, 1]) }));
  await poller.pollAccount(ACCOUNT);
  const queued = store.outboxDue(ACCOUNT, clock.t + 24 * 3_600_000, 50).map((r) => r.event.item);
  assert.equal(queued.length, 2);
  assert.ok(queued.every((item) => item.ids.tvdb === null && item.episodeIds.tvdb === null), "stored without exact ids");

  scrobbler.eventsStatus = 202;
  advance(10 * 60_000);
  await poller.pollAccount(ACCOUNT);
  // The failed attempt and the retry both carried the two events, enriched each time.
  assert.deepEqual(actions(), ["watched!", "watched!", "watched!", "watched!"]);
  const delivered = sentItems().slice(-2);
  assert.deepEqual(delivered.map((i) => i.episodeIds.tvdb).sort(), [219120, 219121]);
  assert.ok(delivered.every((i) => i.ids.tvdb === 76885 && i.ids.tmdb === 30991 && i.numbering === "imdb"));
  assert.equal(store.outboxCount(ACCOUNT), 0);
  await cinemeta.stop();
});

test("with Cinemeta down, events go out exactly as before and nothing is held back", async () => {
  const cinemeta = await withCinemeta((fake) => {
    fake.mode = "destroy";
  });
  stremio.setItem(rawItem(BEBOP_ID, "series", T0 - 1000, { video_id: `${BEBOP_ID}:1:2`, timeOffset: 1 }));
  await poller.pollAccount(ACCOUNT);
  advance(30_000);
  stremio.setItem(rawItem(BEBOP_ID, "series", clock.t - 1000, bebop(90_000, { timesWatched: 1, flaggedWatched: 1 })));
  await poller.pollAccount(ACCOUNT);
  assert.deepEqual(actions(), ["start", "watched"]);
  assert.equal(store.outboxCount(ACCOUNT), 0);
  for (const item of sentItems()) {
    assert.equal(item.ids.imdb, BEBOP_ID);
    assert.equal(item.ids.tvdb, null);
    assert.equal(item.ids.tmdb, null);
    assert.equal(item.episodeIds.tvdb, null);
    assert.equal(item.numbering, "imdb");
    assert.equal(item.season, 1);
    assert.equal(item.episode, 2);
  }
  await cinemeta.stop();
});

test("movies and Kitsu items are sent unchanged and never look anything up", async () => {
  const cinemeta = await withCinemeta();
  stremio.setItem(rawItem("tt0111161", "movie", T0 - 1000, {}));
  stremio.setItem(rawItem("kitsu:1376", "series", T0 - 1000, { video_id: "kitsu:1376:5" }));
  await poller.pollAccount(ACCOUNT);
  advance(30_000);
  stremio.setItem(rawItem("tt0111161", "movie", clock.t - 500, { timesWatched: 1 }));
  stremio.setItem(rawItem("kitsu:1376", "series", clock.t - 500, { video_id: "kitsu:1376:5", timesWatched: 1, watched: watchedField("kitsu:1376:5", 5, [4]) }));
  await poller.pollAccount(ACCOUNT);
  assert.equal(scrobbler.events.length, 2);
  assert.deepEqual(cinemeta.calls, []);
  assert.ok(sentItems().every((i) => i.ids.tvdb === null && i.episodeIds.tvdb === null));
  await cinemeta.stop();
});
