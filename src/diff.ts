import type { PollTuning } from "./config.ts";
import { itemRefFor, manualSessionId, type Action, type ClientEvent } from "./events.ts";
import { EMPTY_SNAPSHOT, IGNORED_TYPES, type ItemSnapshot } from "./library.ts";
import { watchedDelta } from "./watched.ts";

// How a Stremio library item changing between two polls maps to C1 events.
//
// What stremio-core does to a library item (verified in src/models/player.rs):
//  - while playing, `video_id`, `time_offset` (ms), `duration`, `time_watched`
//    and `overall_time_watched` are updated and pushed to the API at most every
//    90 s;
//  - once `time_watched` passes 70 % of `duration` it sets `flagged_watched = 1`,
//    bumps `times_watched` and sets the video's bit in `watched`;
//  - after the credits (90 %), or after "mark as watched", it moves `video_id` to
//    the next video and sets `time_offset = 1` and `flagged_watched = 0`;
//  - "mark as watched" in the UI bumps `times_watched` / sets bits and resets
//    `time_offset` to 0, without touching `time_watched`.
// So a watched change with growing `overall_time_watched` is playback; without
// it, it is a manual mark.

/** stremio-core parks `time_offset` at 1 ms when it advances to the next video. */
const MARKER_MS = 1000;
/** A bulk "mark season as watched" can set hundreds of bits; one item never sends more than this per poll. */
export const MAX_WATCHED_PER_ITEM = 200;
const CLOCK_SKEW_WINDOW_MS = 6 * 3_600_000;

export type Session = {
  id: string;
  videoId: string;
  type: string;
  name: string;
  phase: "playing" | "paused";
  startedAt: number;
  /** When we last saw this play make progress (our clock, not Stremio's). */
  lastActivityAt: number;
  positionMs: number;
  durationMs: number;
};

export type DiffInput = {
  prev: ItemSnapshot | null;
  cur: ItemSnapshot;
  /** `_mtime` of the item as Stremio reports it. */
  mtime: number;
  session: Session | null;
  now: number;
  newSessionId: (videoId: string, startedAt: number) => string;
};

export type DiffResult = {
  events: ClientEvent[];
  session: Session | null;
  /** Playback or a watch mark was seen: keep the account in fast-poll mode. */
  active: boolean;
  /** Watched events dropped by the per-item cap. */
  dropped: number;
};

/** The item's own mtime when it is plausible, else our clock (a skewed client clock must not date events). */
const eventTime = (mtime: number, now: number): number =>
  mtime <= now && mtime >= now - CLOCK_SKEW_WINDOW_MS ? mtime : now;

type EventOptions = { positionMs?: number; durationMs?: number; manual?: boolean };

const makeEvent = (
  action: Action,
  videoId: string,
  name: string,
  sessionId: string,
  at: number,
  options: EventOptions = {},
): ClientEvent | null => {
  const item = itemRefFor(videoId, name);
  if (!item) return null;
  const event: ClientEvent = {
    action,
    occurredAt: new Date(at).toISOString(),
    sessionId,
    manual: options.manual ?? false,
    item,
  };
  if (options.positionMs !== undefined) event.positionMs = options.positionMs;
  if (options.durationMs !== undefined && options.durationMs > 0) event.durationMs = options.durationMs;
  return event;
};

export const diffItem = (input: DiffInput): DiffResult => {
  const { cur, now } = input;
  const base = input.prev ?? EMPTY_SNAPSHOT;
  const events: ClientEvent[] = [];
  let session = input.session;
  const none: DiffResult = { events, session: null, active: false, dropped: 0 };
  if (IGNORED_TYPES.has(cur.type)) return none;

  const at = eventTime(input.mtime, now);
  const push = (event: ClientEvent | null): void => {
    if (event) events.push(event);
  };

  const videoChanged = base.videoId !== cur.videoId;
  const timesUp = cur.timesWatched > base.timesWatched;
  const flaggedUp = cur.flaggedWatched > base.flaggedWatched;
  const delta = watchedDelta(base.watched, cur.watched);
  const unmarked = cur.timesWatched < base.timesWatched || delta.unmarked;

  const sameVideoPlayed =
    !videoChanged &&
    cur.timeOffset > base.timeOffset &&
    (cur.overall > base.overall ||
      cur.timeWatched > base.timeWatched ||
      // A payload without the counters: fall back to the position alone.
      (cur.overall === 0 && cur.timeWatched === 0));
  const newVideoPlayed = videoChanged && cur.videoId !== null && cur.timeOffset > MARKER_MS;
  const playing = sameVideoPlayed || newVideoPlayed;
  // The previous video was finished by playing it and the pointer moved on.
  const completedAdvance =
    videoChanged && base.videoId !== null && timesUp && cur.flaggedWatched === 0 && base.timeOffset > MARKER_MS;

  // 1. Which videos became watched, and was playback behind each.
  let watched: { id: string; manual: boolean }[] = [];
  let dropped = 0;
  if (!unmarked) {
    let ids = delta.added;
    if (ids.length === 0 && (timesUp || flaggedUp)) {
      const target = completedAdvance ? base.videoId : cur.videoId;
      ids = target ? [target] : [];
    }
    if (ids.length > MAX_WATCHED_PER_ITEM) {
      dropped = ids.length - MAX_WATCHED_PER_ITEM;
      ids = ids.slice(0, MAX_WATCHED_PER_ITEM);
    }
    watched = ids.map((id) => ({
      id,
      manual: !((playing && id === cur.videoId) || (completedAdvance && id === base.videoId)),
    }));
  }

  const startSession = (videoId: string, positionMs: number, durationMs: number): Session => {
    const next: Session = {
      id: input.newSessionId(videoId, now),
      videoId,
      type: cur.type,
      name: cur.name,
      phase: "playing",
      startedAt: now,
      lastActivityAt: now,
      positionMs,
      durationMs,
    };
    push(makeEvent("start", videoId, cur.name, next.id, at, { positionMs, durationMs }));
    return next;
  };
  const stopSession = (s: Session, stoppedAt: number): void =>
    push(makeEvent("stop", s.videoId, s.name, s.id, stoppedAt, { positionMs: s.positionMs, durationMs: s.durationMs }));

  const handled = new Set<string>();

  // 2. A video finished while we were not looking: report it against its own play.
  if (completedAdvance && base.videoId) {
    const finished = session?.videoId === base.videoId ? session : startSession(base.videoId, base.timeOffset, base.duration);
    if (watched.some((w) => w.id === base.videoId && !w.manual)) {
      push(makeEvent("watched", base.videoId, cur.name, finished.id, at, { positionMs: base.timeOffset, durationMs: base.duration }));
      handled.add(base.videoId);
    }
    stopSession(finished, at);
    session = null;
  } else if (session && session.videoId !== cur.videoId) {
    // The user moved on to another video without finishing this one.
    stopSession(session, session.lastActivityAt);
    session = null;
  }

  // 3. The video being played now.
  if (playing && cur.videoId) {
    if (!session) {
      session = startSession(cur.videoId, cur.timeOffset, cur.duration);
    } else {
      push(makeEvent("progress", cur.videoId, cur.name, session.id, at, { positionMs: cur.timeOffset, durationMs: cur.duration }));
    }
    session = { ...session, phase: "playing", lastActivityAt: now, positionMs: cur.timeOffset, durationMs: cur.duration || session.durationMs };
    if (watched.some((w) => w.id === cur.videoId && !w.manual) && !handled.has(cur.videoId)) {
      push(makeEvent("watched", cur.videoId, cur.name, session.id, at, { positionMs: cur.timeOffset, durationMs: cur.duration }));
      handled.add(cur.videoId);
    }
  }

  // 4. Everything else that became watched without playback: a manual mark.
  for (const entry of watched) {
    if (handled.has(entry.id)) continue;
    push(makeEvent("watched", entry.id, cur.name, manualSessionId(entry.id, now), at, { manual: true }));
  }

  return { events, session, active: playing || completedAdvance || watched.length > 0, dropped };
};

/** No update for a while: a playing session becomes paused, then ends. */
export const tickSession = (
  session: Session,
  now: number,
  tuning: Pick<PollTuning, "pauseAfterMs" | "stopAfterMs">,
): { events: ClientEvent[]; session: Session | null } => {
  const idle = now - session.lastActivityAt;
  const events: ClientEvent[] = [];
  const stats = { positionMs: session.positionMs, durationMs: session.durationMs };
  if (idle >= tuning.stopAfterMs) {
    const stop = makeEvent("stop", session.videoId, session.name, session.id, session.lastActivityAt, stats);
    if (stop) events.push(stop);
    return { events, session: null };
  }
  if (idle >= tuning.pauseAfterMs && session.phase === "playing") {
    const pause = makeEvent("pause", session.videoId, session.name, session.id, session.lastActivityAt, stats);
    if (pause) events.push(pause);
    return { events, session: { ...session, phase: "paused" } };
  }
  return { events, session };
};
