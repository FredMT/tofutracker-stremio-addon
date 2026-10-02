import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync } from "node:zlib";
import type { ItemSnapshot } from "../src/library.ts";

export const listen = async (handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; url: string; close: () => Promise<void> }> => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};

export const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A Stremio watched field: anchor id, 1-based anchor bit, and the set bit indexes. */
export const watchedField = (anchor: string, anchorLength: number, setBits: number[]): string => {
  const bytes = new Uint8Array(Math.ceil(Math.max(anchorLength, ...setBits.map((b) => b + 1)) / 8));
  for (const bit of setBits) bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (1 << (bit & 7));
  return `${anchor}:${anchorLength}:${deflateSync(bytes).toString("base64")}`;
};

export const snap = (over: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
  type: "series",
  name: "Some Show",
  videoId: "tt0903747:1:1",
  timeOffset: 0,
  timeWatched: 0,
  overall: 0,
  duration: 0,
  timesWatched: 0,
  flaggedWatched: 0,
  watched: null,
  ...over,
});

export type RawState = {
  video_id?: string | null;
  timeOffset?: number;
  timeWatched?: number;
  overallTimeWatched?: number;
  duration?: number;
  timesWatched?: number;
  flaggedWatched?: number;
  watched?: string | null;
};

/** A library item exactly as stremio-core serializes it (camelCase, `_id`, `_mtime`, snake_case `video_id`). */
export const rawItem = (id: string, type: string, mtime: number, state: RawState = {}, name = id): Record<string, unknown> => ({
  _id: id,
  name,
  type,
  poster: null,
  posterShape: "poster",
  removed: false,
  temp: false,
  _ctime: new Date(mtime - 86_400_000).toISOString(),
  _mtime: new Date(mtime).toISOString(),
  state: {
    lastWatched: null,
    timeWatched: 0,
    timeOffset: 0,
    overallTimeWatched: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    duration: 0,
    video_id: id,
    watched: null,
    noNotif: false,
    ...state,
  },
  behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
});

export class FakeStremio {
  library = new Map<string, Record<string, unknown>>();
  validKeys = new Set<string>(["AK1"]);
  linkApproved = false;
  linkAuthKey = "AK1";
  userId = "stremio-user-1";
  calls: string[] = [];
  down = false;
  url = "";
  private closer: (() => Promise<void>) | null = null;

  setItem(raw: Record<string, unknown>): void {
    this.library.set(String(raw["_id"]), raw);
  }

  async start(): Promise<void> {
    const srv = await listen((req, res, body) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      this.calls.push(`${req.method} ${path}`);
      if (this.down) return void res.destroy();
      const input: Record<string, unknown> = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const keyOk = typeof input["authKey"] === "string" && this.validKeys.has(input["authKey"]);
      if (path === "/api/login") {
        return input["password"] === "correct"
          ? reply(res, 200, { result: { authKey: "AK1", user: { _id: this.userId, email: String(input["email"]) } } })
          : reply(res, 200, { error: { code: 3, message: "Wrong passphrase", wrongPass: true } });
      }
      if (path === "/api/v2/create") {
        return reply(res, 200, { result: { success: true, code: "AB12", link: `${this.url}/AB12`, qrcode: `${this.url}/qr?data=x` } });
      }
      if (path === "/api/v2/read") {
        return this.linkApproved
          ? reply(res, 200, { result: { authKey: this.linkAuthKey } })
          : reply(res, 200, { error: { code: 101, message: "Invalid or expired token" } });
      }
      if (!keyOk) return reply(res, 200, { error: { code: 1, message: "Session does not exist" } });
      if (path === "/api/getUser") return reply(res, 200, { result: { _id: this.userId, email: "me@example.com" } });
      if (path === "/api/datastoreMeta") {
        return reply(res, 200, { result: [...this.library.values()].map((i) => [i["_id"], Date.parse(String(i["_mtime"]))]) });
      }
      if (path === "/api/datastoreGet") {
        const ids = new Set(input["ids"] as string[]);
        return reply(res, 200, { result: [...this.library.values()].filter((i) => ids.has(String(i["_id"]))) });
      }
      reply(res, 404, { error: { code: 2, message: "unknown method" } });
    });
    this.url = srv.url;
    this.closer = srv.close;
  }

  stop(): Promise<void> {
    return this.closer?.() ?? Promise.resolve();
  }
}

export type Received = { path: string; auth: string | null; body: Record<string, unknown> };

export class FakeScrobbler {
  received: Received[] = [];
  eventsStatus = 202;
  retryAfter: string | null = null;
  pairPending = true;
  pairDenied = false;
  url = "";
  private closer: (() => Promise<void>) | null = null;

  get events(): Record<string, unknown>[] {
    return this.received.filter((r) => r.path === "/v1/events").flatMap((r) => r.body["events"] as Record<string, unknown>[]);
  }

  async start(): Promise<void> {
    const srv = await listen((req, res, body) => {
      const path = req.url ?? "";
      const parsed: Record<string, unknown> = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      this.received.push({ path, auth: req.headers.authorization ?? null, body: parsed });
      if (path === "/v1/events") {
        return reply(res, this.eventsStatus, { status: "accepted" }, this.retryAfter ? { "retry-after": this.retryAfter } : {});
      }
      if (path === "/v1/pair/start") {
        return reply(res, 200, { deviceCode: "D".repeat(43), userCode: "ABCD-EFGH", verificationUrl: "https://tofutracker.com/link?code=ABCD-EFGH", interval: 3, expiresIn: 600 });
      }
      if (path === "/v1/pair/poll") {
        if (this.pairDenied) return reply(res, 200, { status: "denied" });
        return this.pairPending
          ? reply(res, 200, { status: "pending" })
          : reply(res, 200, { status: "approved", token: "tok-secret-1", connectionId: "conn-1", username: "kalugu" });
      }
      reply(res, 404, {});
    });
    this.url = srv.url;
    this.closer = srv.close;
  }

  stop(): Promise<void> {
    return this.closer?.() ?? Promise.resolve();
  }
}

export type FakeVideo = { id?: string; season?: number; episode?: number; tvdb_id?: unknown };
export type FakeSeries = { tvdb_id?: unknown; moviedb_id?: unknown; videos?: FakeVideo[] };

/** Cowboy Bebop as Cinemeta serves it (checked live 2026-10-02): its S1E2 is TVDB episode 219121. */
export const BEBOP: FakeSeries = {
  tvdb_id: 76885,
  moviedb_id: 30991,
  videos: [
    { id: "tt0213338:1:1", season: 1, episode: 1, tvdb_id: 219120 },
    { id: "tt0213338:1:2", season: 1, episode: 2, tvdb_id: 219121 },
    { id: "tt0213338:1:3", season: 1, episode: 3, tvdb_id: 219122 },
  ],
};

/** A fake Cinemeta: `/meta/series/{imdb}.json`. Unknown ids answer `{}` like the real one. */
export class FakeCinemeta {
  series = new Map<string, FakeSeries>();
  calls: string[] = [];
  /** "ok", an HTTP status, "destroy" (drop the connection) or "hang" (never answer). */
  mode: "ok" | "destroy" | "hang" | number = "ok";
  delayMs = 0;
  url = "";
  private closer: (() => Promise<void>) | null = null;

  async start(): Promise<void> {
    const srv = await listen((req, res) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      this.calls.push(path);
      if (this.mode === "hang") return;
      if (this.mode === "destroy") return void res.destroy();
      const answer = (): void => {
        if (typeof this.mode === "number") return reply(res, this.mode, {});
        const imdb = /^\/meta\/series\/(tt\d+)\.json$/.exec(path)?.[1];
        const found = imdb ? this.series.get(imdb) : undefined;
        reply(res, 200, found && imdb ? { meta: { id: imdb, imdb_id: imdb, type: "series", ...found } } : {});
      };
      if (this.delayMs > 0) setTimeout(answer, this.delayMs);
      else answer();
    });
    this.url = srv.url;
    this.closer = srv.close;
  }

  stop(): Promise<void> {
    return this.closer?.() ?? Promise.resolve();
  }
}
