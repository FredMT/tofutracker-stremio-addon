import type { ClientEvent, ItemRef } from "./events.ts";
import { silentLogger, type Logger } from "./log.ts";

// Cinemeta is the catalog Stremio uses for `tt…` ids. Its series meta carries the
// exact TVDB ids that the IMDb-numbered video ids (`tt0213338:1:2`) cannot express:
//
//   GET {CINEMETA_URL}/meta/series/tt0213338.json
//   { "meta": { "tvdb_id": 76885, "moviedb_id": 30991,
//               "videos": [ { "id": "tt0213338:1:2", "season": 1, "episode": 2, "tvdb_id": 219121, … } ] } }
//
// `tvdb_id` on the meta is the series; on a video it is the TVDB episode. Both are
// sometimes absent (verified live: some series have no `tvdb_id` at all) and are
// ignored unless they are positive integers. An unknown id answers `{}`.
//
// Only the series IMDb id leaves this service, as part of the URL.

export const DEFAULT_CINEMETA_URL = "https://v3-cinemeta.strem.io";

const FOUND_TTL_MS = 24 * 3_600_000;
const MISS_TTL_MS = 3_600_000;
const TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 500;
/** A reply larger than this is treated as a failure (the largest series seen is ~1.4 MB). */
const MAX_BODY_CHARS = 16_000_000;
const MAX_VIDEOS = 20_000;

export type SeriesMeta = {
  /** TVDB series id. */
  tvdb: number | null;
  /** TMDB TV id (`moviedb_id`). */
  tmdb: number | null;
  /** Video id (`tt…:S:E`) to TVDB episode id. */
  episodes: ReadonlyMap<string, number>;
};

export type CinemetaOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  foundTtlMs?: number;
  missTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  log?: Logger;
};

/** What the poller needs: events in, the same events out, possibly with more ids. Never rejects. */
export type EventEnricher = {
  enrichEvents(events: ClientEvent[]): Promise<ClientEvent[]>;
};

type Entry = { meta: SeriesMeta | null; expiresAt: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A positive integer id from a JSON number or a digit string; anything else (0, null, NaN, text) is "absent". */
const positiveId = (value: unknown): number | null => {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

const wholeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Tolerant reading of a Cinemeta reply. Null when there is no usable series meta. */
export const parseSeriesMeta = (imdb: string, body: unknown): SeriesMeta | null => {
  if (!isRecord(body) || !isRecord(body["meta"])) return null;
  const meta = body["meta"];
  const episodes = new Map<string, number>();
  const videos = Array.isArray(meta["videos"]) ? meta["videos"].slice(0, MAX_VIDEOS) : [];
  for (const video of videos) {
    if (!isRecord(video)) continue;
    const tvdb = positiveId(video["tvdb_id"]);
    if (tvdb === null) continue;
    const season = wholeNumber(video["season"]);
    const episode = wholeNumber(video["episode"]);
    const key = typeof video["id"] === "string" && video["id"] ? video["id"] : season !== null && episode !== null ? `${imdb}:${season}:${episode}` : null;
    if (key) episodes.set(key, tvdb);
  }
  return { tvdb: positiveId(meta["tvdb_id"]), tmdb: positiveId(meta["moviedb_id"]), episodes };
};

const isImdbEpisode = (item: ItemRef): item is ItemRef & { ids: { imdb: string }; season: number; episode: number } =>
  item.kind === "episode" && item.numbering === "imdb" && item.ids.imdb !== null && item.season !== null && item.episode !== null;

/**
 * The item with Cinemeta's exact ids added. Existing ids are kept; `imdb`, season,
 * episode and numbering are never touched. Returns the same object when nothing is added.
 */
export const applyCinemeta = (item: ItemRef, meta: SeriesMeta | null): ItemRef => {
  if (!meta || !isImdbEpisode(item)) return item;
  const tvdb = item.ids.tvdb ?? meta.tvdb;
  const tmdb = item.ids.tmdb ?? meta.tmdb;
  const episodeTvdb = item.episodeIds.tvdb ?? meta.episodes.get(`${item.ids.imdb}:${item.season}:${item.episode}`) ?? null;
  if (tvdb === item.ids.tvdb && tmdb === item.ids.tmdb && episodeTvdb === item.episodeIds.tvdb) return item;
  return { ...item, ids: { ...item.ids, tvdb, tmdb }, episodeIds: { ...item.episodeIds, tvdb: episodeTvdb } };
};

export class CinemetaClient implements EventEnricher {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly foundTtlMs: number;
  private readonly missTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly log: Logger;
  /** Insertion order is recency order: a hit moves the entry to the end. */
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<SeriesMeta | null>>();

  constructor(options: CinemetaOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_CINEMETA_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.foundTtlMs = options.foundTtlMs ?? FOUND_TTL_MS;
    this.missTtlMs = options.missTtlMs ?? MISS_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? MAX_ENTRIES);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? silentLogger;
  }

  /** Cache size, for tests and diagnostics. */
  get size(): number {
    return this.cache.size;
  }

  /** The series meta for an IMDb id, or null when Cinemeta does not have it or cannot be reached. Never rejects. */
  series(imdb: string): Promise<SeriesMeta | null> {
    const cached = this.cache.get(imdb);
    if (cached && cached.expiresAt > this.now()) {
      this.cache.delete(imdb);
      this.cache.set(imdb, cached);
      return Promise.resolve(cached.meta);
    }
    const pending = this.inFlight.get(imdb);
    if (pending) return pending;
    const request = this.lookup(imdb)
      .then((outcome) => {
        this.remember(imdb, outcome.meta, outcome.meta ? this.foundTtlMs : this.missTtlMs);
        return outcome.meta;
      })
      .finally(() => this.inFlight.delete(imdb));
    this.inFlight.set(imdb, request);
    return request;
  }

  /** Adds Cinemeta's exact ids to the IMDb-numbered episode events. Every other event, and every event when Cinemeta fails, comes back as it was. */
  async enrichEvents(events: ClientEvent[]): Promise<ClientEvent[]> {
    const wanted = new Set<string>();
    for (const { item } of events) if (isImdbEpisode(item)) wanted.add(item.ids.imdb);
    if (wanted.size === 0) return events;
    const metas = new Map<string, SeriesMeta | null>();
    await Promise.all([...wanted].map(async (imdb) => metas.set(imdb, await this.series(imdb))));
    return events.map((event) => {
      const item = applyCinemeta(event.item, event.item.ids.imdb ? (metas.get(event.item.ids.imdb) ?? null) : null);
      return item === event.item ? event : { ...event, item };
    });
  }

  private remember(imdb: string, meta: SeriesMeta | null, ttlMs: number): void {
    this.cache.delete(imdb);
    this.cache.set(imdb, { meta, expiresAt: this.now() + ttlMs });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private async lookup(imdb: string): Promise<{ meta: SeriesMeta | null }> {
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/meta/series/${encodeURIComponent(imdb)}.json`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        this.log.info("cinemeta: series not found", { imdb, status: 404 });
        return { meta: null };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("reply too large");
      const meta = parseSeriesMeta(imdb, JSON.parse(text) as unknown);
      if (!meta) {
        this.log.info("cinemeta: series not found", { imdb, status: response.status });
        return { meta: null };
      }
      this.log.info("cinemeta: series loaded", { imdb, tvdb: meta.tvdb, tmdb: meta.tmdb, episodes: meta.episodes.size, ms: Date.now() - startedAt });
      return { meta };
    } catch (error) {
      this.log.warn("cinemeta: lookup failed; events go out without exact ids", { imdb, error, ms: Date.now() - startedAt });
      return { meta: null };
    }
  }
}
