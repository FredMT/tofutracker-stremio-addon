// Stremio video ids this addon understands:
//   tt0111161            IMDb movie
//   tt0903747:1:2        IMDb series episode (season:episode, IMDb numbering)
//   kitsu:1376           Kitsu anime (movie or a title without episodes)
//   kitsu:1376:5         Kitsu anime episode (absolute episode number)
// Anything else (local files, youtube, other catalogs) is ignored.

export type ParsedVideoId =
  | { kind: "movie"; source: "imdb"; imdb: string }
  | { kind: "movie"; source: "kitsu"; kitsu: number }
  | { kind: "episode"; source: "imdb"; imdb: string; season: number; episode: number }
  | { kind: "episode"; source: "kitsu"; kitsu: number; episode: number };

const IMDB_MOVIE = /^(tt\d{1,10})$/;
const IMDB_EPISODE = /^(tt\d{1,10}):(\d{1,4}):(\d{1,5})$/;
const KITSU_TITLE = /^kitsu:(\d{1,9})$/;
const KITSU_EPISODE = /^kitsu:(\d{1,9}):(\d{1,5})$/;

export const parseVideoId = (videoId: string): ParsedVideoId | null => {
  let m = IMDB_MOVIE.exec(videoId);
  if (m?.[1]) return { kind: "movie", source: "imdb", imdb: m[1] };
  m = IMDB_EPISODE.exec(videoId);
  if (m?.[1] && m[2] && m[3]) {
    return { kind: "episode", source: "imdb", imdb: m[1], season: Number(m[2]), episode: Number(m[3]) };
  }
  m = KITSU_TITLE.exec(videoId);
  if (m?.[1]) return { kind: "movie", source: "kitsu", kitsu: Number(m[1]) };
  m = KITSU_EPISODE.exec(videoId);
  if (m?.[1] && m[2]) return { kind: "episode", source: "kitsu", kitsu: Number(m[1]), episode: Number(m[2]) };
  return null;
};

/**
 * The id of the episode `delta` positions before/after `videoId` inside the same
 * season (or the same Kitsu title), or null when that would leave the season.
 */
export const shiftEpisode = (videoId: string, delta: number): string | null => {
  const parsed = parseVideoId(videoId);
  if (parsed?.kind !== "episode") return delta === 0 && parsed ? videoId : null;
  const episode = parsed.episode + delta;
  if (episode < 1) return null;
  return parsed.source === "imdb"
    ? `${parsed.imdb}:${parsed.season}:${episode}`
    : `kitsu:${parsed.kitsu}:${episode}`;
};
