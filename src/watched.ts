import { inflateSync } from "node:zlib";
import { parseVideoId, shiftEpisode } from "./ids.ts";

/**
 * Stremio's per-video "watched" field on a library item, as in stremio-core
 * (`stremio-watched-bitfield`): `{anchorVideoId}:{anchorLength}:{base64(zlib(bytes))}`.
 *
 * The bytes are a bitfield over the title's video list (bit i, LSB first, is
 * the i-th video). The anchor names the LAST watched video and `anchorLength`
 * is its 1-based bit position, so the field can be re-aligned when the video
 * list changes. The anchor id may itself contain colons, hence the right split.
 *
 * We do not fetch the video list, so a set bit is mapped to a video id by
 * counting back from the anchor inside its season (or Kitsu title). Bits that
 * would fall into an earlier season cannot be named and are left out.
 */
export type WatchedField = { anchorVideo: string; anchorLength: number; bits: Uint8Array };

export const parseWatchedField = (raw: string): WatchedField | null => {
  const parts = raw.split(":");
  if (parts.length < 3) return null;
  const packed = parts.pop();
  const length = parts.pop();
  if (!packed || !length || !/^\d+$/.test(length)) return null;
  try {
    return {
      anchorVideo: parts.join(":"),
      anchorLength: Number(length),
      bits: new Uint8Array(inflateSync(Buffer.from(packed, "base64"))),
    };
  } catch {
    return null;
  }
};

export type WatchedIds = {
  /** Video ids whose bit is set and that could be named. */
  ids: Set<string>;
  /** Set bits that could not be named (they sit in an earlier season than the anchor). */
  unresolved: number;
};

const EMPTY: WatchedIds = { ids: new Set(), unresolved: 0 };

export const watchedIds = (raw: string | null | undefined): WatchedIds => {
  if (!raw) return EMPTY;
  const field = parseWatchedField(raw);
  if (!field || field.anchorLength < 1) return EMPTY;
  const anchorBit = field.anchorLength - 1;
  const ids = new Set<string>();
  let unresolved = 0;
  for (let bit = 0; bit <= anchorBit && bit < field.bits.length * 8; bit++) {
    if (((field.bits[bit >> 3] ?? 0) >> (bit & 7)) & 1) {
      const id = shiftEpisode(field.anchorVideo, bit - anchorBit);
      if (id) ids.add(id);
      else unresolved++;
    }
  }
  return { ids, unresolved };
};

export type WatchedDelta = {
  /** Videos that are watched now but were not before, in no particular order. */
  added: string[];
  /** A video that was watched before is now explicitly not (the user un-marked it). */
  unmarked: boolean;
};

const seasonOf = (videoId: string): number | null => {
  const parsed = parseVideoId(videoId);
  if (parsed?.kind !== "episode") return null;
  return parsed.source === "imdb" ? parsed.season : 0;
};

/**
 * What changed between two fields. A previously watched id that merely stopped
 * being nameable (the anchor moved to a later season, so the id fell out of the
 * season we can count back through) is NOT an un-mark. One that is nameable in
 * the new field, or later than the new anchor, and is unset, is.
 */
export const watchedDelta = (before: string | null | undefined, after: string | null | undefined): WatchedDelta => {
  const prev = watchedIds(before);
  const next = watchedIds(after);
  const added = [...next.ids].filter((id) => !prev.ids.has(id));
  const nextField = after ? parseWatchedField(after) : null;
  const anchorSeason = nextField ? seasonOf(nextField.anchorVideo) : null;
  let unmarked = false;
  for (const id of prev.ids) {
    if (next.ids.has(id)) continue;
    const season = seasonOf(id);
    if (!nextField || season === null || anchorSeason === null || season >= anchorSeason) {
      unmarked = true;
      break;
    }
  }
  return { added, unmarked };
};
