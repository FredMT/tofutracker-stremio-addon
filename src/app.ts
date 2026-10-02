import type { IncomingMessage, ServerResponse } from "node:http";
import { makeCfg, parseCfg } from "./cfg.ts";
import type { Config } from "./config.ts";
import { aad, open, randomId, seal, stremioUserHash, type Keys } from "./crypto.ts";
import type { Account, Setup, Store } from "./db.ts";
import type { Logger } from "./log.ts";
import { buildManifest } from "./manifest.ts";
import { renderConfigurePage } from "./pages.ts";
import { ScrobblerClient, ScrobblerError } from "./scrobbler-client.ts";
import { StremioApi, StremioError } from "./stremio-api.ts";

export type AppDeps = {
  config: Config;
  store: Store;
  keys: Keys;
  stremio: StremioApi;
  scrobbler: ScrobblerClient;
  poller: { wake: (accountId: string) => void };
  log: Logger;
  now?: () => number;
};

const SETUP_TTL_MS = 3_600_000;
const LINK_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;

type Json = Record<string, unknown>;
type Handler = { status: number; body: string; headers: Record<string, string> };

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Fixed-window counter per key. In memory: it only has to blunt abuse, not survive restarts. */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  check(key: string, max: number, windowMs: number, now: number): void {
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    if (++entry.count > max) throw new HttpError(429, "rate_limited", "Too many requests. Wait a minute and try again.");
  }
}

const PROTOCOL_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export const createApp = (deps: AppDeps) => {
  const { config, store, keys, stremio, scrobbler, poller, log } = deps;
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter();
  const base = config.basePath;
  const origin = config.publicUrl.origin;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => ({
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

  const clientIp = (req: IncomingMessage): string => {
    const forwarded = req.headers["cf-connecting-ip"];
    return (typeof forwarded === "string" ? forwarded : req.socket.remoteAddress) ?? "unknown";
  };

  const readJson = async (req: IncomingMessage): Promise<Json> => {
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "unsupported_media_type", "Send JSON.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body too large.");
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (isRecord(parsed)) return parsed;
    } catch {
      /* fall through */
    }
    throw new HttpError(400, "bad_json", "The request body is not valid JSON.");
  };

  // The setup API is for the configure page only: same origin, JSON, no CORS.
  const guardApi = (req: IncomingMessage): void => {
    const sent = req.headers["origin"];
    if (typeof sent === "string" && sent !== origin) throw new HttpError(403, "forbidden_origin", "Wrong origin.");
    limiter.check(`api:${clientIp(req)}`, 120, 60_000, now());
  };

  const sealFor = (scope: string, field: string, value: string): string => seal(keys, value, aad(scope, field));
  const openFor = (scope: string, field: string, value: string): string => open(keys, value, aad(scope, field));

  // manifest and pages

  const manifestUrl = (cfg: string): string => `${origin}${base}/${cfg}/manifest.json`;
  const installUrl = (cfg: string): string =>
    config.publicUrl.protocol === "https:" ? `stremio://${config.publicUrl.host}${base}/${cfg}/manifest.json` : manifestUrl(cfg);

  const page = (cfg: string | null): Handler => {
    const nonce = randomId(16);
    return {
      status: 200,
      body: renderConfigurePage(nonce, { basePath: base, cfg, linkHost: new URL(config.stremioLinkUrl).host }),
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          `style-src 'nonce-${nonce}'`,
          "connect-src 'self'",
          `img-src 'self' ${config.stremioLinkUrl}`,
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    };
  };

  // setup flow

  type StepView = { state: "idle" | "waiting" | "linked" | "expired" | "denied" } & Json;

  const view = (setup: Setup, account: Account | null): Json => {
    const t = now();
    let tofu: StepView = { state: "idle" };
    if (setup.pairState === "waiting" && setup.pairExpiresAt && setup.pairExpiresAt > t && setup.pairUserCode && setup.pairUrl) {
      tofu = { state: "waiting", userCode: setup.pairUserCode, verificationUrl: setup.pairUrl, retryInMs: Math.max(0, setup.pairNextPollAt - t) };
    } else if (setup.tofuTokenEnc) {
      tofu = { state: "linked", username: setup.tofuUsername };
    } else if (setup.pairState === "denied" || setup.pairState === "expired" || setup.pairState === "waiting") {
      tofu = { state: setup.pairState === "denied" ? "denied" : "expired" };
    } else if (account && account.status !== "needs_tofutracker_relink") {
      tofu = { state: "linked", username: account.tofuUsername };
    }

    let stremioStep: StepView = { state: "idle" };
    if (setup.linkState === "waiting" && setup.linkExpiresAt && setup.linkExpiresAt > t && setup.linkCodeEnc && setup.linkUrl) {
      stremioStep = {
        state: "waiting",
        code: openFor(`setup:${setup.id}`, "link_code", setup.linkCodeEnc),
        link: setup.linkUrl,
        qr: setup.linkQr,
        retryInMs: Math.max(0, setup.linkNextPollAt - t),
      };
    } else if (setup.stremioAuthEnc) {
      stremioStep = { state: "linked" };
    } else if (setup.linkState === "waiting" || setup.linkState === "expired") {
      stremioStep = { state: "expired" };
    } else if (account && account.status !== "needs_stremio_signin") {
      stremioStep = { state: "linked" };
    }

    return {
      setupId: setup.id,
      tofu,
      stremio: stremioStep,
      ready: tofu.state === "linked" && stremioStep.state === "linked",
      ...(account ? { account: { status: account.status } } : {}),
    };
  };

  const loadSetup = (id: string): { setup: Setup; account: Account | null } => {
    const setup = store.getSetup(id, now());
    if (!setup) throw new HttpError(404, "unknown_setup", "This page expired. Reload it to start again.");
    return { setup, account: setup.accountId ? store.getAccount(setup.accountId) : null };
  };

  const reload = (id: string): Json => {
    const { setup, account } = loadSetup(id);
    return view(setup, account);
  };

  const recordStremioSignIn = async (setup: Setup, authKey: string, knownUserId: string | null): Promise<void> => {
    let userId = knownUserId;
    if (!userId) {
      try {
        userId = (await stremio.getUser(authKey)).id;
      } catch {
        userId = null; // best effort: it only lets us recognise an account that is linked already
      }
    }
    store.updateSetup(setup.id, {
      stremioAuthEnc: sealFor(`setup:${setup.id}`, "stremio_auth", authKey),
      stremioUserHash: userId ? stremioUserHash(keys, userId) : null,
      linkState: "linked",
      linkCodeEnc: null,
    });
  };

  const apiRoute = async (req: IncomingMessage, method: string, segments: string[]): Promise<Handler> => {
    guardApi(req);
    const [, area, id, ...rest] = segments;
    const sub = rest.join("/");

    if (area === "setup" && !id && method === "POST") {
      const body = await readJson(req);
      let accountId: string | null = null;
      if (typeof body["cfg"] === "string") {
        accountId = parseCfg(keys, body["cfg"]);
        if (!accountId || !store.getAccount(accountId)) throw new HttpError(404, "unknown_account", "This addon link is not recognised.");
      }
      const setupId = randomId(16);
      store.insertSetup(setupId, accountId, now(), SETUP_TTL_MS);
      return json(200, reload(setupId));
    }

    if (area === "account" && id && sub === "unlink" && method === "POST") {
      const accountId = parseCfg(keys, id);
      if (!accountId || !store.getAccount(accountId)) throw new HttpError(404, "unknown_account", "This addon link is not recognised.");
      store.deleteAccount(accountId);
      log.info("account unlinked");
      return json(200, { ok: true });
    }

    if (area !== "setup" || !id) throw new HttpError(404, "not_found", "Not found.");
    const scope = `setup:${id}`;

    if (sub === "tofu/start" && method === "POST") {
      limiter.check(`pair:${clientIp(req)}`, 10, 60_000, now());
      loadSetup(id);
      let pair;
      try {
        pair = await scrobbler.pairStart("Stremio addon");
      } catch (error) {
        log.warn("pair/start failed", { error });
        throw new HttpError(502, "scrobbler_unavailable", "TofuTracker is not reachable right now. Try again in a minute.");
      }
      store.updateSetup(id, {
        pairDeviceEnc: sealFor(scope, "pair_device", pair.deviceCode),
        pairUserCode: pair.userCode,
        pairUrl: pair.verificationUrl,
        pairState: "waiting",
        pairExpiresAt: now() + pair.expiresInS * 1000,
        pairIntervalMs: pair.intervalS * 1000,
        pairNextPollAt: now() + pair.intervalS * 1000,
      });
      return json(200, reload(id));
    }

    if (sub === "tofu/poll" && method === "GET") {
      const { setup } = loadSetup(id);
      const t = now();
      if (setup.pairState !== "waiting" || !setup.pairDeviceEnc) return json(200, reload(id));
      if (setup.pairExpiresAt !== null && t > setup.pairExpiresAt) {
        store.updateSetup(id, { pairState: "expired", pairDeviceEnc: null });
        return json(200, reload(id));
      }
      if (t < setup.pairNextPollAt) return json(200, reload(id));
      store.updateSetup(id, { pairNextPollAt: t + setup.pairIntervalMs });
      try {
        const result = await scrobbler.pairPoll(openFor(scope, "pair_device", setup.pairDeviceEnc));
        if (result.status === "approved") {
          store.updateSetup(id, {
            tofuTokenEnc: sealFor(scope, "tofu_token", result.token),
            tofuUsername: result.username,
            tofuConnectionId: result.connectionId,
            pairState: "linked",
            pairDeviceEnc: null,
          });
        } else if (result.status !== "pending") {
          store.updateSetup(id, { pairState: result.status, pairDeviceEnc: null });
        }
      } catch (error) {
        log.warn("pair/poll failed", { error }); // keep waiting; the next poll retries
      }
      return json(200, reload(id));
    }

    if (sub === "stremio/link/start" && method === "POST") {
      limiter.check(`link:${clientIp(req)}`, 10, 60_000, now());
      loadSetup(id);
      try {
        const link = await stremio.linkCreate();
        store.updateSetup(id, {
          linkCodeEnc: sealFor(scope, "link_code", link.code),
          linkUrl: link.link,
          linkQr: link.qrcode,
          linkState: "waiting",
          linkExpiresAt: now() + LINK_TTL_MS,
          linkNextPollAt: now() + 3000,
        });
      } catch (error) {
        log.warn("Stremio link create failed", { error });
        throw new HttpError(502, "stremio_unavailable", "Stremio is not reachable right now. Try again, or use email and password.");
      }
      return json(200, reload(id));
    }

    if (sub === "stremio/link/poll" && method === "GET") {
      const { setup } = loadSetup(id);
      const t = now();
      if (setup.linkState !== "waiting" || !setup.linkCodeEnc) return json(200, reload(id));
      if (setup.linkExpiresAt !== null && t > setup.linkExpiresAt) {
        store.updateSetup(id, { linkState: "expired", linkCodeEnc: null });
        return json(200, reload(id));
      }
      if (t < setup.linkNextPollAt) return json(200, reload(id));
      store.updateSetup(id, { linkNextPollAt: t + 3000 });
      try {
        const authKey = await stremio.linkRead(openFor(scope, "link_code", setup.linkCodeEnc));
        await recordStremioSignIn(setup, authKey, null);
      } catch (error) {
        // Stremio answers "Invalid or expired token" until the code is entered; that is the normal waiting state.
        if (!(error instanceof StremioError) || error.kind !== "pending") log.warn("Stremio link read failed", { error });
      }
      return json(200, reload(id));
    }

    if (sub === "stremio/login" && method === "POST") {
      limiter.check(`login:${clientIp(req)}`, 6, 60_000, now());
      const { setup } = loadSetup(id);
      const body = await readJson(req);
      const email = typeof body["email"] === "string" ? body["email"].trim() : "";
      const password = typeof body["password"] === "string" ? body["password"] : "";
      if (!email || email.length > 254 || !password || password.length > 256) {
        throw new HttpError(400, "invalid_input", "Enter your Stremio email and password.");
      }
      try {
        const signedIn = await stremio.login(email, password);
        await recordStremioSignIn(setup, signedIn.authKey, signedIn.user.id);
      } catch (error) {
        if (error instanceof StremioError && error.kind === "credentials") {
          throw new HttpError(401, "wrong_credentials", "Stremio rejected that email or password.");
        }
        log.warn("Stremio login failed", { reason: error instanceof StremioError ? error.kind : "unexpected" });
        throw new HttpError(502, "stremio_unavailable", "Could not sign in to Stremio right now. Try the link code instead.");
      }
      return json(200, reload(id));
    }

    if (sub === "stremio/authkey" && method === "POST") {
      limiter.check(`authkey:${clientIp(req)}`, 10, 60_000, now());
      const { setup } = loadSetup(id);
      const body = await readJson(req);
      const authKey = typeof body["authKey"] === "string" ? body["authKey"].trim() : "";
      if (!/^\S{1,512}$/.test(authKey)) throw new HttpError(400, "invalid_input", "That does not look like an auth key.");
      try {
        await stremio.libraryMeta(authKey); // proves the key works and can read the library
      } catch (error) {
        if (error instanceof StremioError && error.kind === "session") {
          throw new HttpError(400, "invalid_auth_key", "Stremio does not accept that auth key.");
        }
        throw new HttpError(502, "stremio_unavailable", "Could not check the key with Stremio. Try again.");
      }
      await recordStremioSignIn(setup, authKey, null);
      return json(200, reload(id));
    }

    if (sub === "finish" && method === "POST") {
      const { setup, account } = loadSetup(id);
      const hasTofu = setup.tofuTokenEnc !== null;
      const hasStremio = setup.stremioAuthEnc !== null;
      // The same Stremio user signing in again reuses their account, so the addon link they installed keeps working.
      const target = account ?? (setup.stremioUserHash ? store.findAccountByStremioUser(setup.stremioUserHash) : null);

      const needsTofu = !hasTofu && (!target || target.status === "needs_tofutracker_relink");
      const needsStremio = !hasStremio && (!target || target.status === "needs_stremio_signin");
      if (needsTofu || needsStremio) throw new HttpError(409, "incomplete", "Finish both steps first.");

      const t = now();
      let accountId: string;
      if (target) {
        accountId = target.id;
        const changes: Parameters<Store["updateCredentials"]>[1] = {};
        if (setup.tofuTokenEnc) {
          changes.tofuTokenEnc = sealFor(accountId, "tofu_token", openFor(scope, "tofu_token", setup.tofuTokenEnc));
          changes.tofuUsername = setup.tofuUsername;
          changes.tofuConnectionId = setup.tofuConnectionId;
        }
        if (setup.stremioAuthEnc) {
          changes.stremioAuthEnc = sealFor(accountId, "stremio_auth", openFor(scope, "stremio_auth", setup.stremioAuthEnc));
          if (setup.stremioUserHash) changes.stremioUserHash = setup.stremioUserHash;
          changes.keepLibraryState = setup.stremioUserHash !== null && setup.stremioUserHash === target.stremioUserHash;
        }
        store.updateCredentials(accountId, changes, t);
      } else {
        if (!setup.tofuTokenEnc || !setup.stremioAuthEnc) throw new HttpError(409, "incomplete", "Finish both steps first.");
        accountId = randomId(16);
        store.insertAccount(
          {
            id: accountId,
            tofuTokenEnc: sealFor(accountId, "tofu_token", openFor(scope, "tofu_token", setup.tofuTokenEnc)),
            tofuUsername: setup.tofuUsername,
            tofuConnectionId: setup.tofuConnectionId,
            stremioAuthEnc: sealFor(accountId, "stremio_auth", openFor(scope, "stremio_auth", setup.stremioAuthEnc)),
            stremioUserHash: setup.stremioUserHash,
          },
          t,
        );
      }
      store.deleteSetup(id);
      const cfg = makeCfg(keys, accountId);
      log.info("account configured", { created: !target });
      return json(200, { manifestUrl: manifestUrl(cfg), installUrl: installUrl(cfg), cfg });
    }

    throw new HttpError(404, "not_found", "Not found.");
  };

  // protocol routes

  const protocolRoute = (segments: string[], method: string): Handler | null => {
    if (method !== "GET") return null;
    const [first, second, third, fourth, fifth] = segments;
    const cors = PROTOCOL_CORS;

    if (first === "manifest.json" && segments.length === 1) {
      return json(200, buildManifest(config.version, "unconfigured"), { ...cors, "cache-control": "no-cache" });
    }
    if (!first || first.length !== 44) return null;
    const accountId = parseCfg(keys, first);

    if (second === "manifest.json" && segments.length === 2) {
      const account = accountId ? store.getAccount(accountId) : null;
      if (!account) return json(404, { error: "unknown_account" }, cors);
      return json(200, buildManifest(config.version, account.status), { ...cors, "cache-control": "no-cache" });
    }

    if (second === "configure" && segments.length === 2) {
      return accountId && store.getAccount(accountId) ? page(first) : json(404, { error: "unknown_account" });
    }

    if (second === "subtitles" && third && fourth && (segments.length === 4 || segments.length === 5) && (fifth ?? fourth).endsWith(".json")) {
      // The reply is always empty. The request itself is the signal: a video was opened.
      if (accountId && store.getAccount(accountId)?.status === "ok") poller.wake(accountId);
      return json(200, { subtitles: [], cacheMaxAge: 0 }, cors);
    }
    return null;
  };

  const route = async (req: IncomingMessage, method: string, pathname: string): Promise<{ handler: Handler; name: string }> => {
    if (!pathname.startsWith(base) || (pathname.length > base.length && pathname[base.length] !== "/")) {
      return { handler: json(404, { error: "not_found" }), name: "outside" };
    }
    const segments = pathname.slice(base.length).split("/").filter(Boolean).map(safeDecode);
    const [first] = segments;

    if (method === "OPTIONS" && first !== "api") {
      return { handler: { status: 204, body: "", headers: PROTOCOL_CORS }, name: "preflight" };
    }
    if (segments.length === 0) {
      return { handler: { status: 302, body: "", headers: { location: `${base}/configure` } }, name: "root" };
    }
    if (first === "health" && segments.length === 1 && method === "GET") {
      const ok = store.ping();
      return { handler: json(ok ? 200 : 503, { status: ok ? "ok" : "unavailable" }), name: "health" };
    }
    if (first === "configure" && segments.length === 1 && method === "GET") return { handler: page(null), name: "configure" };
    if (first === "api") return { handler: await apiRoute(req, method, segments), name: "api" };

    const handler = protocolRoute(segments, method);
    const name = segments[1] === "subtitles" ? "subtitles" : segments[1] === "manifest.json" || first === "manifest.json" ? "manifest" : segments[1] ?? "other";
    return { handler: handler ?? json(404, { error: "not_found" }), name };
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = now();
    const method = req.method ?? "GET";
    let name = "unmatched";
    let result: Handler;
    try {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const routed = await route(req, method, pathname);
      result = routed.handler;
      name = routed.name;
    } catch (error) {
      if (error instanceof HttpError) {
        result = json(error.status, { error: error.code, message: error.message });
      } else {
        log.error("unhandled error", { error });
        result = json(500, { error: "internal", message: "Something went wrong." });
      }
      if (error instanceof ScrobblerError) result = json(502, { error: "scrobbler_unavailable", message: "TofuTracker is not reachable right now." });
    }
    res.writeHead(result.status, {
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...result.headers,
    });
    res.end(result.body);
    if (name !== "health") log.info("request", { method, route: name, status: result.status, ms: now() - started });
  };
};
