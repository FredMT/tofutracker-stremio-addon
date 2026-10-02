// Stremio library items, parsed defensively. The live API is unofficial: every
// field we use is validated, every field we do not use is ignored, and an item
// that does not look like a library item is skipped instead of failing the poll.

export type ItemSnapshot = {
  type: string;
  name: string;
  videoId: string | null;
  timeOffset: number;
  timeWatched: number;
  overall: number;
  duration: number;
  timesWatched: number;
  flaggedWatched: number;
  watched: string | null;
};

export type LibraryItem = {
  id: string;
  removed: boolean;
  temp: boolean;
  mtime: number;
  snapshot: ItemSnapshot;
};

export const EMPTY_SNAPSHOT: ItemSnapshot = {
  type: "",
  name: "",
  videoId: null,
  timeOffset: 0,
  timeWatched: 0,
  overall: 0,
  duration: 0,
  timesWatched: 0,
  flaggedWatched: 0,
  watched: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

const toMillis = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

/** `{ _id, name, type, removed, temp, _mtime, state: {...} }` as stremio-core `LibraryItem` serializes it. */
export const parseLibraryItem = (raw: unknown): LibraryItem | null => {
  if (!isRecord(raw)) return null;
  const id = text(raw["_id"]);
  const state = raw["state"];
  const mtime = toMillis(raw["_mtime"]);
  if (!id || !isRecord(state) || mtime === null) return null;
  const type = text(raw["type"]) ?? "";
  // stremio-core renames this one field to snake case; accept both spellings.
  // A movie marked as watched before it was ever played has no video id; its
  // only video is the item itself.
  const videoId = text(state["video_id"]) ?? text(state["videoId"]) ?? (type === "movie" ? id : null);
  return {
    id,
    removed: raw["removed"] === true,
    temp: raw["temp"] === true,
    mtime,
    snapshot: {
      type,
      name: text(raw["name"]) ?? id,
      videoId,
      timeOffset: count(state["timeOffset"]),
      timeWatched: count(state["timeWatched"]),
      overall: count(state["overallTimeWatched"]),
      duration: count(state["duration"]),
      timesWatched: count(state["timesWatched"]),
      flaggedWatched: count(state["flaggedWatched"]),
      watched: text(state["watched"]),
    },
  };
};

/** `datastoreMeta` result: `[[id, mtimeMs], ...]`. Returns id -> mtime, skipping malformed rows. */
export const parseMetaEntries = (raw: unknown): Map<string, number> => {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const id = text(row[0]);
    const mtime = toMillis(row[1]);
    if (id && mtime !== null) out.set(id, mtime);
  }
  return out;
};

/** Item types that are never scrobbled: live TV, channels and the catch-all "other". */
export const IGNORED_TYPES = new Set(["tv", "channel", "other"]);
