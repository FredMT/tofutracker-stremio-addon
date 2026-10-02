export type PollTuning = {
  /** Poll interval while an account is "active" (a subtitles ping or a recent change). */
  activeIntervalMs: number;
  /** Poll interval for every account regardless of activity. */
  baselineIntervalMs: number;
  /** How long an account stays active after the last wake or change. */
  activeWindowMs: number;
  /** No library update for this long while playing means the player paused. */
  pauseAfterMs: number;
  /** No library update for this long means the play ended. */
  stopAfterMs: number;
  /** Never poll one account more often than this, however many pings arrive. */
  minGapMs: number;
};

export type Config = {
  publicUrl: URL;
  /** Path prefix the service is mounted under, without a trailing slash ("" for the root). */
  basePath: string;
  scrobblerUrl: string;
  credsKey: Buffer;
  dataDir: string;
  port: number;
  stremioApiUrl: string;
  stremioLinkUrl: string;
  poll: PollTuning;
  version: string;
};

export const DEFAULT_POLL: PollTuning = {
  activeIntervalMs: 30_000,
  baselineIntervalMs: 15 * 60_000,
  activeWindowMs: 20 * 60_000,
  // Stremio pushes the playing item to its API every 90 s at most, so a quiet
  // item is only "paused" once a push is clearly overdue.
  pauseAfterMs: 150_000,
  stopAfterMs: 10 * 60_000,
  minGapMs: 10_000,
};

export const VERSION = "1.0.0";

export class ConfigError extends Error {}

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const parseCredsKey = (raw: string | undefined): Buffer => {
  if (!raw) throw new ConfigError("STREMIO_CREDS_KEY is required (32 random bytes, hex or base64)");
  const value = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new ConfigError("STREMIO_CREDS_KEY must decode to exactly 32 bytes (hex: 64 chars)");
  }
  return key;
};

export const loadConfig = (env: Record<string, string | undefined>): Config => {
  const publicUrl = new URL(env["PUBLIC_URL"] || "https://scrobble.tofutracker.com/stremio");
  const port = Number(env["PORT"] || 7000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT is not a valid port");
  return {
    publicUrl,
    basePath: stripTrailingSlash(publicUrl.pathname),
    scrobblerUrl: stripTrailingSlash(env["SCROBBLER_URL"] || "http://scrobbler:8080"),
    credsKey: parseCredsKey(env["STREMIO_CREDS_KEY"]),
    dataDir: env["DATA_DIR"] || "/data",
    port,
    stremioApiUrl: stripTrailingSlash(env["STREMIO_API_URL"] || "https://api.strem.io"),
    stremioLinkUrl: stripTrailingSlash(env["STREMIO_LINK_URL"] || "https://link.stremio.com"),
    poll: DEFAULT_POLL,
    version: VERSION,
  };
};
