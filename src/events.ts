import { parseVideoId } from "./ids.ts";

// Client event contract C1 (docs/scrobbler-clients.md in the TofuTracker repo).

export type Action = "start" | "progress" | "pause" | "stop" | "watched";

export type ItemIds = {
  imdb: string | null;
  tmdb: number | null;
  tvdb: number | null;
  anidb: number | null;
  anilist: number | null;
  mal: number | null;
  kitsu: number | null;
};

export type ItemRef = {
  kind: "movie" | "episode";
  title: string;
  ids: ItemIds;
  episodeIds: { tvdb: number | null; tmdb: number | null; imdb: string | null };
  season: number | null;
  episode: number | null;
  numbering: "imdb" | null;
};

export type ClientEvent = {
  action: Action;
  occurredAt: string;
  sessionId: string;
  positionMs?: number;
  durationMs?: number;
  manual: boolean;
  item: ItemRef;
};

export type ClientInfo = { name: string; version: string; server: string };

export type EventsRequest = { client: ClientInfo; events: ClientEvent[] };

export const MAX_EVENTS_PER_REQUEST = 50;

const NO_IDS: ItemIds = { imdb: null, tmdb: null, tvdb: null, anidb: null, anilist: null, mal: null, kitsu: null };

/** The C1 `item` for a Stremio video id, or null when the id is not one we map. */
export const itemRefFor = (videoId: string, name: string): ItemRef | null => {
  const parsed = parseVideoId(videoId);
  if (!parsed) return null;
  const noEpisodeIds = { tvdb: null, tmdb: null, imdb: null };
  if (parsed.kind === "movie") {
    return {
      kind: "movie",
      title: name,
      ids: parsed.source === "imdb" ? { ...NO_IDS, imdb: parsed.imdb } : { ...NO_IDS, kitsu: parsed.kitsu },
      episodeIds: noEpisodeIds,
      season: null,
      episode: null,
      numbering: null,
    };
  }
  if (parsed.source === "imdb") {
    return {
      kind: "episode",
      title: `${name} S${parsed.season}E${parsed.episode}`,
      ids: { ...NO_IDS, imdb: parsed.imdb },
      episodeIds: noEpisodeIds,
      season: parsed.season,
      episode: parsed.episode,
      numbering: "imdb",
    };
  }
  // Kitsu episodes are numbered absolutely; there is no season.
  return {
    kind: "episode",
    title: `${name} E${parsed.episode}`,
    ids: { ...NO_IDS, kitsu: parsed.kitsu },
    episodeIds: noEpisodeIds,
    season: null,
    episode: parsed.episode,
    numbering: null,
  };
};

export const manualSessionId = (videoId: string, at: number): string =>
  `manual:${videoId}:${new Date(at).toISOString().slice(0, 10)}`;
