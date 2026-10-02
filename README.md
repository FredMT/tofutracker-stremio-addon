# TofuTracker Stremio addon

Adds what you watch in Stremio to your [TofuTracker](https://tofutracker.com) library.

Stremio addons never see playback, so this one does not try to. You link your Stremio account once, and the service reads your Stremio library (the same data the Stremio apps sync between your devices). When an item's progress moves, an episode crosses Stremio's own "watched" line, or you mark something watched by hand, it reports an event to the TofuTracker scrobbler. The addon you install in Stremio exists to give you a personal link and to tell the service when you open a video, so it polls sooner.

It is a small Node 24 + TypeScript service with no runtime dependencies. State lives in one SQLite file (`node:sqlite`).

## How it works

```
 Stremio apps ── open a video ──► GET /stremio/{cfg}/subtitles/…   (answers { "subtitles": [] }, wakes the poller)

 poller ──► api.strem.io  datastoreMeta (ids + mtimes) ─► datastoreGet (only the items that changed)
        └─► diff against the last seen state ─► C1 events ─► exact ids from Cinemeta ─► POST {SCROBBLER_URL}/v1/events
```

- **Sign-in.** The configure page links two accounts. TofuTracker uses the device-code flow (C2): the page shows a code, you approve it on tofutracker.com. Stremio uses, in order of preference, a **link code** (Stremio's own `link.stremio.com` flow, works for Google and Facebook accounts and never shows us a password), **email and password** (exchanged once at `api.strem.io/api/login`, then forgotten) or a **pasted auth key**.
- **Link code convenience.** The Stremio step opens the `link` URL from Stremio's reply in a new tab and has a Copy code button. The last step points to `tofutracker.com/settings/scrobbling`, where the connection can be revoked.
- **Install.** The last step shows an Install button (`stremio://…/stremio/{cfg}/manifest.json`) and the https address to copy.
- **`{cfg}`** is a random 128-bit account id plus a truncated HMAC of it (44 URL-safe characters). It names your account and carries no credentials. Treat it as private anyway: it is the key to your configure page.
- **Baseline.** The first poll after linking only records where your library is. Nothing old is imported.
- **Polling.** A subtitles request from Stremio wakes that account: it is polled every 30 s until 20 minutes pass with no change (never more than once per 10 s). Every account is also polled every 15 minutes.
- **Needs sign-in.** If Stremio rejects the stored key, or the TofuTracker token is revoked (401), the account stops polling and the manifest name says what to redo (`TofuTracker (sign in to Stremio again)`). Open the configure page from Stremio's addon settings to fix it; your addon link stays the same.

### What a library change means

stremio-core updates a library item while you play: `video_id`, `time_offset`, `duration`, `time_watched`. It sets `flagged_watched`, bumps `times_watched` and sets the video's bit in the `watched` field once more than 70 % of the video was actually watched, and pushes the item to the API at most every 90 s. After the credits (or "mark as watched") it moves `video_id` to the next video with `time_offset = 1`. The addon turns that into C1 events:

| Library change                                                                | Event                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| position moved while `overallTimeWatched` grew (or a new video got past 1 s)  | `start`, then `progress` on each later change          |
| no update for 150 s while playing                                             | `pause` (Stremio sends no pause signal; this is inferred) |
| no update for 10 min, or the user moved on to another video                   | `stop`                                                 |
| watched flag / `timesWatched` / watched bit set while playing                 | `watched`, `manual: false`, on the play's session      |
| the same change with no playback behind it (marked by hand, or a bulk mark)   | `watched`, `manual: true`, session `manual:{videoId}:{yyyy-mm-dd}` |
| `video_id` advanced with `time_offset` of 1 ms after a finished video         | `stop` for the finished video; no start for the next one |
| a watched bit or `timesWatched` going down                                    | nothing (un-marking is not synced)                     |

Ids: `tt…` is `ids.imdb`; episodes `tt…:S:E` add `season`, `episode` and `numbering: "imdb"`, then get exact ids from Cinemeta (next section). `kitsu:ID` and `kitsu:ID:EP` become `ids.kitsu` (episode absolute, `season` and `numbering` null). Anything else (local files, YouTube, other catalogs) is ignored.

### Exact episode ids from Cinemeta

A Stremio video id like `tt0213338:1:2` uses IMDb/Cinemeta numbering, which differs from TVDB's for many anime (Cinemeta's Cowboy Bebop S1E2, "Stray Dog Strut", is TVDB episode 219121, which TVDB numbers S1E1). From the id alone the scrobbler can only guess the episode (`assumed`), and an assumed anime episode goes to a review queue or lands on the wrong episode. Cinemeta, the catalog Stremio itself uses for `tt…` ids, already knows the exact ids, so the addon asks it:

```
GET {CINEMETA_URL}/meta/series/tt0213338.json
  meta.tvdb_id             76885    TVDB series id
  meta.moviedb_id          30991    TMDB TV id
  meta.videos[].id         "tt0213338:1:2"
  meta.videos[].tvdb_id    219121   TVDB episode id
```

Every event for a `tt…:S:E` item (start, progress, pause, stop, watched, manual watched) is enriched just before it is sent: `ids.tvdb` is the series id, `ids.tmdb` the TMDB TV id and `episodeIds.tvdb` the video's own TVDB id. Each is added only when Cinemeta has a positive value for it. `ids.imdb`, `season`, `episode` and `numbering: "imdb"` stay as they are, and the session id does not change. The queued event is not modified, so a retry after a failure or restart is enriched as well.

- **Fallbacks.** If Cinemeta is down, slow (5 s timeout), does not know the series or has no value for a field, the event goes out exactly as it did before this feature. Cinemeta never blocks or drops an event, and a `watched` event waits for it at most the timeout, once per series. Movies (`tt…` without season) and `kitsu:` ids are not looked up.
- **Cache.** In memory, at most 500 series (least recently used first out). A found series is kept 24 h; "not found" and failures are kept 1 h, so an outage costs one wait per hour, not one per event. Concurrent lookups of one series share a single request. Nothing is stored on disk.
- **Verified shapes** (live, 2026-10-02): `meta.videos[].tvdb_id` is the TVDB episode id (e.g. Cowboy Bebop `tt0213338:1:2` is 219121, Breaking Bad `tt0903747:1:1` is 349232). `meta.tvdb_id` and `meta.moviedb_id` can be absent (for example *The Three Stooges Show* has no `tvdb_id` anywhere), and an unknown id answers `{}` with HTTP 200 (after a redirect to `cinemeta-live.strem.io`), so absent, zero or non-numeric values are all treated as "no id". Large series are big (One Piece: 1.4 MB, 1242 videos); only the id map is kept.
- **Privacy.** The only thing sent to Cinemeta is the series IMDb id (`tt…`) in the request URL, the same request any Stremio app makes. No account, token, library content, watch time or event is sent, and the request carries no cookies or identifiers.

Limits worth knowing:

- The watched bitfield is relative to the title's video list, which the addon does not use for this (Cinemeta's list is only read for episode ids). A bit is named by counting back from the field's anchor inside the anchor's season (or the Kitsu title). A bulk "mark all as watched" that spans several seasons therefore reports the anchor's season only. At most 200 watched events are sent per item per poll.
- Progress and pause timing has the resolution of Stremio's 90 s push interval plus the poll interval.
- A video finished while nobody polled shows up as `start`, `watched`, `stop` in one batch.

## Stremio API notes (unofficial)

The API is undocumented. This is what the code relies on and how far each shape is verified. "Live" means checked against the real API on 2026-10-02 using dummy input only; there were no Stremio credentials, so no successful authenticated reply was ever seen.

| Call                                                             | Request                                                                                                                                      | Reply                                                                                                                               | Status                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST api.strem.io/api/login`                                    | `{ "type": "Login", "email", "password", "facebook": false }` (stremio-core `AuthRequest::Login`)                                            | `{ "result": { "authKey", "user": { "_id", "email", … } } }`                                                                          | Request and the error reply `{ "error": { "code": 3, "message": "Wrong passphrase", "wrongPass": true } }` (HTTP 200) are live. Success reply is from stremio-core only. |
| `GET link.stremio.com/api/v2/create?type=Create`                 | none                                                                                                                                         | `{ "result": { "success": true, "code": "1U9B", "link": "https://link.stremio.com/1U9B", "qrcode": "…" } }`                           | Live.                                                                                        |
| `GET link.stremio.com/api/v2/read?type=Read&code=CODE`           | none                                                                                                                                         | `{ "result": { "authKey" } }` once the code is entered; `{ "error": { "code": 101, "message": "Invalid or expired token" } }` before | Error reply live (same for pending, expired and unknown codes, so they cannot be told apart). Success reply from stremio-core `LinkAuthKey`. |
| `POST api.strem.io/api/datastoreMeta`                            | `{ "authKey", "collection": "libraryItem" }`                                                                                                 | `{ "result": [["itemId", mtimeMs], …] }`                                                                                              | Endpoint, request and the error reply `{ "error": { "code": 1, "message": "Session does not exist" } }` are live. Success reply from stremio-core `LibraryItemModified`. |
| `POST api.strem.io/api/datastoreGet`                             | `{ "authKey", "collection": "libraryItem", "ids": […], "all": false }`                                                                       | `{ "result": [LibraryItem, …] }`                                                                                                      | As above. `LibraryItem` and its `state` (`video_id`, `timeOffset`, `duration`, `timesWatched`, `flaggedWatched`, `watched`, …) from stremio-core `library_item.rs`. |
| `POST api.strem.io/api/getUser`                                  | `{ "authKey" }`                                                                                                                              | `{ "result": { "_id", "email", … } }`                                                                                                 | From stremio-core only. Optional: it only lets the addon recognise a Stremio user who is already linked. |

Sources: [stremio-core](https://github.com/Stremio/stremio-core) (`src/types/api/request.rs`, `response.rs`, `src/models/link.rs`, `src/types/library/library_item.rs`, `src/models/player.rs`, `stremio-watched-bitfield/`) and the [addon SDK docs](https://github.com/Stremio/stremio-addon-sdk/tree/master/docs) (manifest, subtitles, protocol). The `watched` decoder is tested against the literals in the crate's own unit tests.

The client ignores unknown fields, validates the ones it uses, skips library items that do not parse, and maps `error.code 1` to "needs sign-in". If Stremio changes the API, the effect is an account marked "needs sign-in" or a failed poll with backoff. Nothing else in the service is affected.

Not confirmed anywhere: how long a link code lives (the page gives up after 10 minutes), whether Stremio caches the empty subtitles reply (the reply carries `cacheMaxAge: 0` and `Cache-Control: no-store`), and whether the apps request subtitles for every video.

## Configuration

Environment variables (see `.env.example`):

| Variable            | Default                                  | Meaning                                                                     |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `STREMIO_CREDS_KEY` | required                                 | 32 random bytes, hex or base64. AES-256-GCM key material and HMAC key.      |
| `PUBLIC_URL`        | `https://scrobble.tofutracker.com/stremio` | Public address. Its path is the prefix the service is mounted under.        |
| `SCROBBLER_URL`     | `http://scrobbler:8080`                  | Scrobbler base URL (`/v1/pair/*`, `/v1/events`).                            |
| `DATA_DIR`          | `/data`                                  | Where `stremio-addon.sqlite` lives.                                         |
| `PORT`              | `7000`                                   | Listen port.                                                                |
| `CINEMETA_URL`      | `https://v3-cinemeta.strem.io`           | Where exact TVDB ids for `tt…:S:E` videos come from.                        |
| `STREMIO_API_URL`, `STREMIO_LINK_URL` | the real hosts         | Only to point tests at a fake server.                                       |

Two subkeys are derived from `STREMIO_CREDS_KEY` with HKDF: one for AES-256-GCM, one for HMAC-SHA256. Stored Stremio auth keys and TofuTracker connection tokens are encrypted with the owner (account id plus column name) as associated data, so a value copied into another row fails to open. Losing or changing the key means every user has to set the addon up again.

## Security

- Passwords, auth keys and tokens are never logged (the logger redacts field names that could hold them) and never returned by the API. The password goes from the browser to this service to Stremio and is dropped.
- The setup API under `/stremio/api` is for the configure page only: same origin, JSON only, 16 KiB bodies, per-IP rate limits, no CORS headers. Only the addon protocol routes (manifest, subtitles) send `Access-Control-Allow-Origin: *`, which Stremio requires.
- The logo (`/stremio/logo.png`, 256x256) and background (`/stremio/background.png`) in the manifests are static PNGs from `assets/`, regenerated with `node scripts/make-assets.ts`.
- The configure page ships a CSP with a per-response nonce, `frame-ancestors 'none'` and no external scripts.
- The container runs as uid 1000 with a read-only filesystem, no capabilities and a memory limit. It publishes no ports.

## Run it

```bash
cp .env.example .env            # set STREMIO_CREDS_KEY
npm ci
npm test                        # node:test, no network
npx tsc --noEmit
npm run build && DATA_DIR=./data PUBLIC_URL=http://localhost:7000/stremio node --env-file=.env dist/index.js
```

`npm run dev` runs the TypeScript directly (Node 24 strips the types). Open `http://localhost:7000/stremio/configure`. Pairing needs a scrobbler at `SCROBBLER_URL`.

In Docker, without installing Node:

```bash
docker run --rm -v "$PWD":/app -w /app node:24-alpine sh -c 'npm ci && npx tsc --noEmit && npm test'
docker build -t tofutracker-stremio-addon:dev .
```

## Deploy (TofuTracker VPS)

1. Check out the repo in `~/projects/stremio-addon`.
2. Create the env file once. The key is generated on the server and never printed:
   ```bash
   umask 077
   printf 'STREMIO_CREDS_KEY=%s\n' "$(openssl rand -hex 32)" > ~/secrets/stremio-addon.env
   ```
   Add `PUBLIC_URL` or `SCROBBLER_URL` only if they differ from the defaults.
3. `docker compose up -d --build`. The compose project is `stremio-addon`; the container joins the existing `scrobbler_default` network, publishes no ports, keeps its SQLite file in the `stremio-addon_state` volume and answers as `http://stremio-addon:7000` on that network.
4. Route the tunnel to it. The cloudflared container of the scrobbler project is already on `scrobbler_default`, so in the Cloudflare dashboard (Zero Trust, Networks, Tunnels, the scrobbler tunnel, Public hostnames) add a rule for hostname `scrobble.tofutracker.com`, path `/stremio` (everything below it), service `HTTP` `stremio-addon:7000`. It must sit above the catch-all rule for that hostname that points to `scrobbler:8080`. Do not strip the path: the service expects the `/stremio` prefix. If a path rule is not possible, use a second hostname and set `PUBLIC_URL` to match.
5. Check it:
   ```bash
   docker compose ps                                                  # healthy
   curl -s https://scrobble.tofutracker.com/stremio/health            # {"status":"ok"}
   curl -s https://scrobble.tofutracker.com/stremio/manifest.json     # configurationRequired: true
   ```
6. Update with `git pull && docker compose up -d --build`. Back up the volume with `docker run --rm -v stremio-addon_state:/data -v "$PWD":/backup alpine cp -r /data /backup/stremio-addon-data`. `docker compose down` keeps it.

## Layout

```
src/index.ts             entry: config, store, poller, HTTP server
src/app.ts               routes: manifest, subtitles, configure page, setup API, health
src/pages.ts             the configure page (inline CSS and JS)
src/poller.ts            scheduling, library polling, outbox delivery, backoff
src/diff.ts              library item change -> C1 events, session pause/stop timing
src/cinemeta.ts          Cinemeta client: exact TVDB/TMDB ids for episodes, cached
src/library.ts           tolerant parsing of library items
src/watched.ts           decoder for the `watched` field
src/stremio-api.ts       Stremio client (login, link code, datastore, getUser)
src/scrobbler-client.ts  scrobbler client (pairing C2, events C1)
src/db.ts                SQLite store (accounts, item state, outbox, setup)
src/crypto.ts, cfg.ts    AES-256-GCM, HMAC, the {cfg} segment
src/manifest.ts, events.ts, ids.ts, config.ts, log.ts, healthcheck.ts
assets/                  logo.png and background.png served by the manifest routes
scripts/make-assets.ts   generates assets/ (no dependencies)
test/                    node:test; fake Stremio, scrobbler and Cinemeta HTTP servers in helpers.ts
```

## License

MIT
