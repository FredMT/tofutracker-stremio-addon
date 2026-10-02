import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { applyCinemeta, CinemetaClient, parseSeriesMeta } from "../src/cinemeta.ts";
import type { Action, ClientEvent } from "../src/events.ts";
import { itemRefFor } from "../src/events.ts";
import { BEBOP, FakeCinemeta } from "./helpers.ts";

let fake: FakeCinemeta;
let clock: { t: number };
const HOUR = 3_600_000;

beforeEach(async () => {
  fake = new FakeCinemeta();
  fake.series.set("tt0213338", BEBOP);
  await fake.start();
  clock = { t: Date.parse("2026-10-03T12:00:00Z") };
});
afterEach(() => fake.stop());

const client = (over: Partial<ConstructorParameters<typeof CinemetaClient>[0]> = {}) =>
  new CinemetaClient({ baseUrl: fake.url, timeoutMs: 1000, now: () => clock.t, ...over });

const eventFor = (videoId: string, action: Action = "progress", sessionId = "s1", manual = false): ClientEvent => {
  const item = itemRefFor(videoId, "Cowboy Bebop");
  assert.ok(item);
  return { action, occurredAt: "2026-10-03T12:00:00.000Z", sessionId, positionMs: 1000, manual, item };
};

test("S1E2 of Cowboy Bebop gets the series ids and TVDB episode 219121", async () => {
  const [out] = await client().enrichEvents([eventFor("tt0213338:1:2", "start")]);
  assert.ok(out);
  assert.deepEqual(out.item.ids, { imdb: "tt0213338", tmdb: 30991, tvdb: 76885, anidb: null, anilist: null, mal: null, kitsu: null });
  assert.deepEqual(out.item.episodeIds, { tvdb: 219121, tmdb: null, imdb: null });
  // Everything else is as built from the video id.
  assert.equal(out.item.season, 1);
  assert.equal(out.item.episode, 2);
  assert.equal(out.item.numbering, "imdb");
  assert.equal(out.item.kind, "episode");
  assert.equal(out.item.title, "Cowboy Bebop S1E2");
  assert.deepEqual(fake.calls, ["/meta/series/tt0213338.json"]);
});

test("every action, manual watched included, is enriched and keeps its session id", async () => {
  const actions: Action[] = ["start", "progress", "pause", "stop", "watched"];
  const input = [
    ...actions.map((action) => eventFor("tt0213338:1:2", action, "stremio:abc:tt0213338:1:2:1")),
    eventFor("tt0213338:1:3", "watched", "manual:tt0213338:1:3:2026-10-03", true),
  ];
  const before = JSON.stringify(input);
  const out = await client().enrichEvents(input);
  assert.equal(JSON.stringify(input), before, "the queued events are not modified");
  assert.deepEqual(out.map((e) => e.sessionId), input.map((e) => e.sessionId));
  assert.deepEqual(out.map((e) => e.action), [...actions, "watched"]);
  assert.deepEqual(out.map((e) => e.item.episodeIds.tvdb), [219121, 219121, 219121, 219121, 219121, 219122]);
  assert.ok(out.every((e) => e.item.ids.tvdb === 76885 && e.item.ids.tmdb === 30991));
  assert.equal(out[5]?.manual, true);
  assert.equal(out[0]?.positionMs, 1000);
  assert.equal(fake.calls.length, 1, "one fetch for all of them");
});

test("a video Cinemeta does not list keeps the series ids and has no episode id", async () => {
  const [out] = await client().enrichEvents([eventFor("tt0213338:9:9")]);
  assert.equal(out?.item.ids.tvdb, 76885);
  assert.equal(out?.item.ids.tmdb, 30991);
  assert.equal(out?.item.episodeIds.tvdb, null);
});

test("absent and zero ids are ignored", async () => {
  fake.series.set("tt0000001", {
    tvdb_id: 0,
    moviedb_id: 555,
    videos: [
      { id: "tt0000001:1:1", tvdb_id: 0 },
      { id: "tt0000001:1:2" },
      { id: "tt0000001:1:3", tvdb_id: null },
      { id: "tt0000001:1:4", tvdb_id: -4 },
      { id: "tt0000001:1:5", tvdb_id: "x" },
      { id: "tt0000001:1:6", tvdb_id: 600 },
    ],
  });
  fake.series.set("tt0000002", { videos: [{ id: "tt0000002:1:1", tvdb_id: 11 }] }); // no series ids at all
  const out = await client().enrichEvents([
    ...[1, 2, 3, 4, 5, 6].map((n) => eventFor(`tt0000001:1:${n}`)),
    eventFor("tt0000002:1:1"),
  ]);
  assert.deepEqual(out.map((e) => e.item.episodeIds.tvdb), [null, null, null, null, null, 600, 11]);
  assert.equal(out[0]?.item.ids.tvdb, null, "series tvdb_id 0 is absent");
  assert.equal(out[0]?.item.ids.tmdb, 555);
  assert.equal(out[6]?.item.ids.tvdb, null);
  assert.equal(out[6]?.item.ids.tmdb, null);
});

test("a series without any usable id leaves the event object untouched", async () => {
  fake.series.set("tt0000003", { tvdb_id: 0, moviedb_id: 0, videos: [{ id: "tt0000003:1:1", tvdb_id: 0 }] });
  const event = eventFor("tt0000003:1:1");
  const [out] = await client().enrichEvents([event]);
  assert.equal(out, event);
});

test("series Cinemeta does not know are sent as they are, and remembered as unknown for an hour", async () => {
  const event = eventFor("tt7777777:1:1");
  const c = client();
  assert.equal((await c.enrichEvents([event]))[0], event);
  assert.equal((await c.enrichEvents([event]))[0], event);
  assert.equal(fake.calls.length, 1);
  clock.t += HOUR - 1;
  await c.enrichEvents([event]);
  assert.equal(fake.calls.length, 1);
  clock.t += 2;
  await c.enrichEvents([event]);
  assert.equal(fake.calls.length, 2);
});

test("movies, Kitsu ids and season-less events never reach Cinemeta", async () => {
  const events = [eventFor("tt0111161"), eventFor("kitsu:1376"), eventFor("kitsu:1376:5")];
  const out = await client().enrichEvents(events);
  assert.deepEqual(out, events);
  assert.deepEqual(fake.calls, []);
});

test("Cinemeta down: the events come back unchanged and the failure is remembered for an hour", async () => {
  const events = [eventFor("tt0213338:1:2", "start"), eventFor("tt0213338:1:2", "watched")];
  const c = client();
  for (const mode of ["destroy", 500, 404] as const) {
    fake.mode = mode;
    clock.t += 2 * HOUR; // outlast the previous failure
    const out = await c.enrichEvents(events);
    assert.deepEqual(out, events, `mode ${mode}`);
    assert.equal(out[0]?.item.ids.tvdb, null);
  }
  // Failure cached: Cinemeta coming back is not noticed until the hour is up.
  fake.mode = "ok";
  const calls = fake.calls.length;
  assert.equal((await c.enrichEvents(events))[0]?.item.episodeIds.tvdb, null);
  assert.equal(fake.calls.length, calls);
  clock.t += HOUR + 1;
  assert.equal((await c.enrichEvents(events))[0]?.item.episodeIds.tvdb, 219121);
});

test("an answer that is not JSON, or has no meta, is a miss", async () => {
  assert.equal(parseSeriesMeta("tt1", null), null);
  assert.equal(parseSeriesMeta("tt1", []), null);
  assert.equal(parseSeriesMeta("tt1", {}), null);
  assert.equal(parseSeriesMeta("tt1", { meta: "x" }), null);
  assert.deepEqual(parseSeriesMeta("tt1", { meta: { tvdb_id: "42", moviedb_id: 7, videos: "no" } }), { tvdb: 42, tmdb: 7, episodes: new Map() });
  // A video without an id is keyed by its season and episode.
  assert.equal(parseSeriesMeta("tt1", { meta: { videos: [{ season: 2, episode: 3, tvdb_id: 9 }] } })?.episodes.get("tt1:2:3"), 9);
});

test("a Cinemeta that never answers costs at most the timeout, once", async () => {
  fake.mode = "hang";
  const c = client({ timeoutMs: 150 });
  const events = [eventFor("tt0213338:1:2", "watched")];
  const startedAt = Date.now();
  const out = await c.enrichEvents(events);
  const took = Date.now() - startedAt;
  assert.deepEqual(out, events);
  assert.ok(took >= 100 && took < 1500, `took ${took} ms`);
  const again = Date.now();
  await c.enrichEvents(events);
  assert.ok(Date.now() - again < 50, "the failure is cached, no second wait");
  assert.equal(fake.calls.length, 1);
});

test("many events, many batches: one fetch while the entry is fresh", async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c.enrichEvents([eventFor("tt0213338:1:1"), eventFor("tt0213338:1:2"), eventFor("tt0213338:1:3", "watched")]);
  assert.equal(fake.calls.length, 1);
});

test("found series are cached for 24 hours, then fetched again", async () => {
  const c = client();
  const event = eventFor("tt0213338:1:2");
  await c.enrichEvents([event]);
  clock.t += 24 * HOUR - 1;
  assert.equal((await c.enrichEvents([event]))[0]?.item.episodeIds.tvdb, 219121);
  assert.equal(fake.calls.length, 1);
  clock.t += 2;
  await c.enrichEvents([event]);
  assert.equal(fake.calls.length, 2);
});

test("concurrent lookups of one series share one request", async () => {
  fake.delayMs = 100;
  const c = client();
  const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => c.enrichEvents([eventFor("tt0213338:1:2", "progress", `s${i}`)])));
  assert.equal(fake.calls.length, 1);
  assert.ok(outs.every((out) => out[0]?.item.episodeIds.tvdb === 219121));
  // Two different series in one batch are fetched side by side.
  fake.series.set("tt0903747", { tvdb_id: 81189, moviedb_id: 1396, videos: [{ id: "tt0903747:1:1", tvdb_id: 349232 }] });
  const startedAt = Date.now();
  const both = await client().enrichEvents([eventFor("tt0213338:1:1"), eventFor("tt0903747:1:1")]);
  assert.ok(Date.now() - startedAt < 190, "parallel, not one after the other");
  assert.deepEqual(both.map((e) => e.item.episodeIds.tvdb), [219120, 349232]);
  assert.equal(both[1]?.item.ids.tvdb, 81189);
});

test("the cache is capped; the least recently used series goes first", async () => {
  for (const n of [1, 2, 3]) fake.series.set(`tt000010${n}`, { tvdb_id: n });
  const c = client({ maxEntries: 2 });
  const touch = (imdb: string) => c.enrichEvents([eventFor(`${imdb}:1:1`)]);
  await touch("tt0001001");
  await touch("tt0001002");
  await touch("tt0001001"); // refresh 1; 2 is now the oldest
  await touch("tt0001003"); // evicts 2
  assert.equal(c.size, 2);
  assert.equal(fake.calls.length, 3);
  await touch("tt0001001");
  assert.equal(fake.calls.length, 3, "1 is still cached");
  await touch("tt0001002");
  assert.equal(fake.calls.length, 4, "2 was evicted");
});

test("applyCinemeta keeps ids that are already there", () => {
  const item = itemRefFor("tt0213338:1:2", "Cowboy Bebop");
  assert.ok(item);
  const had = { ...item, ids: { ...item.ids, tvdb: 1 }, episodeIds: { ...item.episodeIds, tvdb: 2 } };
  const meta = parseSeriesMeta("tt0213338", { meta: BEBOP });
  const out = applyCinemeta(had, meta);
  assert.equal(out.ids.tvdb, 1);
  assert.equal(out.episodeIds.tvdb, 2);
  assert.equal(out.ids.tmdb, 30991);
});
