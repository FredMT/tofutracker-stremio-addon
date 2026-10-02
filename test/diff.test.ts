import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLL } from "../src/config.ts";
import { diffItem, MAX_WATCHED_PER_ITEM, tickSession, type DiffInput, type Session } from "../src/diff.ts";
import { snap, watchedField } from "./helpers.ts";

const NOW = Date.parse("2026-10-02T14:00:00Z");
const newSessionId = (videoId: string, startedAt: number): string => `s:${videoId}:${startedAt}`;

const run = (over: Partial<DiffInput> & Pick<DiffInput, "cur">) =>
  diffItem({ prev: null, mtime: NOW, session: null, now: NOW, newSessionId, ...over });

const actions = (events: { action: string; manual: boolean }[]): string[] => events.map((e) => e.action + (e.manual ? "!" : ""));

test("playback appearing starts a session, then reports progress", () => {
  const prev = snap({ timeOffset: 1, videoId: "tt0903747:1:1" });
  const first = run({ prev, cur: snap({ timeOffset: 90_000, overall: 90_000, timeWatched: 90_000, duration: 2_700_000 }) });
  assert.deepEqual(actions(first.events), ["start"]);
  assert.equal(first.events[0]?.positionMs, 90_000);
  assert.equal(first.events[0]?.durationMs, 2_700_000);
  assert.equal(first.events[0]?.item.ids.imdb, "tt0903747");
  assert.equal(first.events[0]?.item.numbering, "imdb");
  assert.equal(first.session?.phase, "playing");
  assert.equal(first.active, true);

  const second = run({
    prev: snap({ timeOffset: 90_000, overall: 90_000, timeWatched: 90_000, duration: 2_700_000 }),
    cur: snap({ timeOffset: 180_000, overall: 180_000, timeWatched: 180_000, duration: 2_700_000 }),
    session: first.session,
    now: NOW + 90_000,
  });
  assert.deepEqual(actions(second.events), ["progress"]);
  assert.equal(second.events[0]?.sessionId, first.events[0]?.sessionId);
  assert.equal(second.events[0]?.positionMs, 180_000);
});

test("an item that did not move produces nothing", () => {
  const s = snap({ timeOffset: 500, overall: 500, timeWatched: 500 });
  const result = run({ prev: s, cur: s });
  assert.deepEqual(result.events, []);
  assert.equal(result.active, false);
});

test("a seek alone (position moved, nothing was watched) is not playback", () => {
  const result = run({
    prev: snap({ timeOffset: 1000, overall: 5000, timeWatched: 5000 }),
    cur: snap({ timeOffset: 900_000, overall: 5000, timeWatched: 5000 }),
  });
  assert.deepEqual(result.events, []);
});

test("an idle session pauses after 150 s and stops after 10 min", () => {
  const session: Session = { id: "s1", videoId: "tt0903747:1:1", type: "series", name: "Show", phase: "playing", startedAt: NOW, lastActivityAt: NOW, positionMs: 60_000, durationMs: 2_000_000 };
  assert.deepEqual(tickSession(session, NOW + 100_000, DEFAULT_POLL).events, []);

  const paused = tickSession(session, NOW + 160_000, DEFAULT_POLL);
  assert.deepEqual(actions(paused.events), ["pause"]);
  assert.equal(paused.events[0]?.positionMs, 60_000);
  assert.equal(paused.session?.phase, "paused");
  // Already paused: no second pause.
  assert.deepEqual(tickSession(paused.session as Session, NOW + 200_000, DEFAULT_POLL).events, []);

  const stopped = tickSession(paused.session as Session, NOW + 11 * 60_000, DEFAULT_POLL);
  assert.deepEqual(actions(stopped.events), ["stop"]);
  assert.equal(stopped.session, null);
  // A playing session that was never seen idle goes straight to stop.
  assert.deepEqual(actions(tickSession(session, NOW + 11 * 60_000, DEFAULT_POLL).events), ["stop"]);
});

test("progress after a pause resumes the same session", () => {
  const paused: Session = { id: "s1", videoId: "tt0903747:1:1", type: "series", name: "Show", phase: "paused", startedAt: NOW, lastActivityAt: NOW, positionMs: 60_000, durationMs: 2_000_000 };
  const result = run({
    prev: snap({ timeOffset: 60_000, overall: 60_000, timeWatched: 60_000 }),
    cur: snap({ timeOffset: 400_000, overall: 400_000, timeWatched: 400_000, duration: 2_000_000 }),
    session: paused,
    now: NOW + 600_000,
  });
  assert.deepEqual(actions(result.events), ["progress"]);
  assert.equal(result.events[0]?.sessionId, "s1");
  assert.equal(result.session?.phase, "playing");
});

test("crossing the watched threshold during playback emits a non-manual watched on the same session", () => {
  const prev = snap({ videoId: "tt0903747:1:1", timeOffset: 1_500_000, overall: 1_500_000, timeWatched: 1_500_000, duration: 2_000_000 });
  const session: Session = { id: "s1", videoId: "tt0903747:1:1", type: "series", name: "Some Show", phase: "playing", startedAt: NOW - 600_000, lastActivityAt: NOW - 90_000, positionMs: 1_500_000, durationMs: 2_000_000 };
  const cur = snap({
    videoId: "tt0903747:1:1",
    timeOffset: 1_600_000,
    overall: 1_600_000,
    timeWatched: 1_600_000,
    duration: 2_000_000,
    timesWatched: 1,
    flaggedWatched: 1,
    watched: watchedField("tt0903747:1:1", 1, [0]),
  });
  const result = run({ prev, cur, session });
  assert.deepEqual(actions(result.events), ["progress", "watched"]);
  assert.equal(result.events[1]?.sessionId, "s1");
  assert.equal(result.events[1]?.manual, false);
  assert.equal(result.events[1]?.item.episode, 1);
});

test("a play that went from nothing to watched between two polls reports start then watched", () => {
  const prev = snap({ videoId: "tt0111161", type: "movie", timeOffset: 0 });
  const cur = snap({ videoId: "tt0111161", type: "movie", timeOffset: 7_000_000, overall: 7_000_000, timeWatched: 6_000_000, duration: 8_000_000, timesWatched: 1, flaggedWatched: 1 });
  const result = run({ prev, cur });
  assert.deepEqual(actions(result.events), ["start", "watched"]);
  assert.equal(result.events[0]?.sessionId, result.events[1]?.sessionId);
  assert.equal(result.events[1]?.item.kind, "movie");
});

test("marking a movie as watched by hand is a manual watched with a day-keyed session", () => {
  const prev = snap({ type: "movie", videoId: "tt0111161", timesWatched: 0 });
  const cur = snap({ type: "movie", videoId: "tt0111161", timesWatched: 1, timeOffset: 0 });
  const result = run({ prev, cur });
  assert.deepEqual(actions(result.events), ["watched!"]);
  assert.equal(result.events[0]?.sessionId, "manual:tt0111161:2026-10-02");
  assert.equal(result.events[0]?.positionMs, undefined);
  assert.equal(result.session, null);
  assert.equal(result.active, true);
});

test("flaggedWatched flipping on its own counts as a manual mark", () => {
  const result = run({ prev: snap({ type: "movie", videoId: "tt0111161" }), cur: snap({ type: "movie", videoId: "tt0111161", flaggedWatched: 1 }) });
  assert.deepEqual(actions(result.events), ["watched!"]);
});

test("marking several episodes through the watched bitfield emits one manual watched each", () => {
  const prev = snap({ videoId: "tt0903747:1:1" });
  const cur = snap({ videoId: "tt0903747:1:1", timesWatched: 3, watched: watchedField("tt0903747:1:3", 3, [0, 1, 2]) });
  const result = run({ prev, cur });
  assert.deepEqual(actions(result.events), ["watched!", "watched!", "watched!"]);
  assert.deepEqual(result.events.map((e) => e.item.episode).sort(), [1, 2, 3]);
  assert.deepEqual(new Set(result.events.map((e) => e.sessionId)).size, 3);
});

test("only the newly set bits are reported", () => {
  const prev = snap({ timesWatched: 2, watched: watchedField("tt0903747:1:2", 2, [0, 1]) });
  const cur = snap({ timesWatched: 3, watched: watchedField("tt0903747:1:5", 5, [0, 1, 4]) });
  const result = run({ prev, cur });
  assert.deepEqual(result.events.map((e) => e.item.episode), [5]);
  assert.equal(result.events[0]?.manual, true);
});

test("un-marking reports nothing", () => {
  const prev = snap({ timesWatched: 3, watched: watchedField("tt0903747:1:3", 3, [0, 1, 2]) });
  const cur = snap({ timesWatched: 2, watched: watchedField("tt0903747:1:2", 2, [0, 1]) });
  assert.deepEqual(run({ prev, cur }).events, []);
  assert.deepEqual(run({ prev: snap({ type: "movie", videoId: "tt1", timesWatched: 1 }), cur: snap({ type: "movie", videoId: "tt1", timesWatched: 0 }) }).events, []);
});

test("advancing to the next video with the 1 ms marker is not a play of the next episode", () => {
  const session: Session = { id: "s1", videoId: "tt0903747:1:1", type: "series", name: "Some Show", phase: "playing", startedAt: NOW - 1_800_000, lastActivityAt: NOW - 60_000, positionMs: 2_500_000, durationMs: 2_700_000 };
  const prev = snap({ videoId: "tt0903747:1:1", timeOffset: 2_500_000, overall: 2_500_000, timeWatched: 2_500_000, duration: 2_700_000, timesWatched: 1, flaggedWatched: 1, watched: watchedField("tt0903747:1:1", 1, [0]) });
  const cur = snap({ videoId: "tt0903747:1:2", timeOffset: 1, overall: 5_000_000, timeWatched: 0, duration: 2_700_000, timesWatched: 1, flaggedWatched: 0, watched: watchedField("tt0903747:1:1", 1, [0]) });
  const result = run({ prev, cur, session });
  assert.deepEqual(actions(result.events), ["stop"]);
  assert.equal(result.events[0]?.sessionId, "s1");
  assert.equal(result.session, null);
});

test("a video finished while nobody polled is reported against its own play, then stopped", () => {
  const prev = snap({ videoId: "tt0903747:1:1", timeOffset: 1_000_000, overall: 1_000_000, timeWatched: 1_000_000, duration: 2_700_000 });
  const cur = snap({ videoId: "tt0903747:1:2", timeOffset: 1, overall: 2_700_000, timeWatched: 0, duration: 2_700_000, timesWatched: 1, flaggedWatched: 0, watched: watchedField("tt0903747:1:1", 1, [0]) });
  const result = run({ prev, cur });
  assert.deepEqual(actions(result.events), ["start", "watched", "stop"]);
  assert.deepEqual(result.events.map((e) => e.item.episode), [1, 1, 1]);
  assert.equal(result.events[1]?.manual, false);
  assert.equal(result.session, null);
});

test("moving on to another video without finishing stops the old session and starts the new one", () => {
  const session: Session = { id: "s1", videoId: "tt0903747:1:1", type: "series", name: "Some Show", phase: "playing", startedAt: NOW - 600_000, lastActivityAt: NOW - 60_000, positionMs: 300_000, durationMs: 2_700_000 };
  const prev = snap({ videoId: "tt0903747:1:1", timeOffset: 300_000, overall: 300_000, timeWatched: 300_000 });
  const cur = snap({ videoId: "tt0903747:1:4", timeOffset: 120_000, overall: 420_000, timeWatched: 120_000, duration: 2_700_000 });
  const result = run({ prev, cur, session });
  assert.deepEqual(actions(result.events), ["stop", "start"]);
  assert.deepEqual(result.events.map((e) => e.item.episode), [1, 4]);
  assert.notEqual(result.events[0]?.sessionId, result.events[1]?.sessionId);
});

test("a rewatch bumps timesWatched with the bit already set: still a non-manual watched", () => {
  const field = watchedField("tt0903747:1:1", 1, [0]);
  const prev = snap({ videoId: "tt0903747:1:1", timeOffset: 1_900_000, overall: 9_000_000, timeWatched: 100, duration: 2_000_000, timesWatched: 1, flaggedWatched: 0, watched: field });
  const cur = snap({ videoId: "tt0903747:1:1", timeOffset: 1_950_000, overall: 9_300_000, timeWatched: 1_500_000, duration: 2_000_000, timesWatched: 2, flaggedWatched: 1, watched: field });
  const result = run({ prev, cur });
  assert.deepEqual(actions(result.events), ["start", "watched"]);
  assert.equal(result.events[1]?.manual, false);
});

test("Kitsu episodes map to a Kitsu id with an absolute episode and no season", () => {
  const prev = snap({ type: "anime", videoId: "kitsu:1376:4", timeOffset: 1 });
  const cur = snap({ type: "anime", videoId: "kitsu:1376:4", timeOffset: 200_000, overall: 200_000, timeWatched: 200_000, duration: 1_400_000 });
  const [event] = run({ prev, cur }).events;
  assert.deepEqual([event?.action, event?.item.ids.kitsu, event?.item.ids.imdb, event?.item.season, event?.item.episode, event?.item.numbering], ["start", 1376, null, null, 4, null]);
});

test("ids from other catalogs and live types are ignored", () => {
  const playing = { timeOffset: 200_000, overall: 200_000, timeWatched: 200_000 };
  assert.deepEqual(run({ prev: snap({ videoId: "yt_id:abc", timeOffset: 1 }), cur: snap({ videoId: "yt_id:abc", ...playing }) }).events, []);
  assert.deepEqual(run({ prev: snap({ type: "tv", videoId: "tt1", timeOffset: 1 }), cur: snap({ type: "tv", videoId: "tt1", ...playing }) }).events, []);
});

test("an item first seen after the baseline is diffed against nothing", () => {
  const result = run({ prev: null, cur: snap({ type: "movie", videoId: "tt0111161", timesWatched: 1 }) });
  assert.deepEqual(actions(result.events), ["watched!"]);
});

test("a bulk mark is capped per item", () => {
  const count = MAX_WATCHED_PER_ITEM + 50;
  const cur = snap({ videoId: "tt0903747:1:1", timesWatched: count, watched: watchedField(`tt0903747:1:${count}`, count, Array.from({ length: count }, (_, i) => i)) });
  const result = run({ prev: snap({ videoId: "tt0903747:1:1" }), cur });
  assert.equal(result.events.length, MAX_WATCHED_PER_ITEM);
  assert.equal(result.dropped, 50);
});

test("an implausible Stremio mtime does not date the events", () => {
  const prev = snap({ timeOffset: 1 });
  const cur = snap({ timeOffset: 90_000, overall: 90_000, timeWatched: 90_000 });
  const future = run({ prev, cur, mtime: NOW + 30 * 86_400_000 });
  assert.equal(future.events[0]?.occurredAt, new Date(NOW).toISOString());
  const recent = run({ prev, cur, mtime: NOW - 45_000 });
  assert.equal(recent.events[0]?.occurredAt, new Date(NOW - 45_000).toISOString());
});
