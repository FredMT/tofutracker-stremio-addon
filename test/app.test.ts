import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { createApp } from "../src/app.ts";
import { makeCfg } from "../src/cfg.ts";
import { loadConfig } from "../src/config.ts";
import { aad, deriveKeys, open } from "../src/crypto.ts";
import { Store } from "../src/db.ts";
import { createLogger } from "../src/log.ts";
import { ScrobblerClient } from "../src/scrobbler-client.ts";
import { StremioApi } from "../src/stremio-api.ts";
import { FakeScrobbler, FakeStremio } from "./helpers.ts";

const KEY_HEX = "ab".repeat(32);
const keys = deriveKeys(Buffer.from(KEY_HEX, "hex"));
const BASE = "https://scrobble.example/stremio";

let stremio: FakeStremio;
let scrobbler: FakeScrobbler;
let store: Store;
let server: Server;
let origin: string;
let woken: string[];
let logs: string[];
let clock: { t: number };

beforeEach(async () => {
  stremio = new FakeStremio();
  scrobbler = new FakeScrobbler();
  await Promise.all([stremio.start(), scrobbler.start()]);
  store = new Store(":memory:");
  woken = [];
  logs = [];
  clock = { t: Date.now() };
  const config = loadConfig({ STREMIO_CREDS_KEY: KEY_HEX, PUBLIC_URL: BASE, SCROBBLER_URL: scrobbler.url, STREMIO_API_URL: stremio.url, STREMIO_LINK_URL: stremio.url });
  const handle = createApp({
    config,
    store,
    keys,
    stremio: new StremioApi({ apiUrl: stremio.url, linkUrl: stremio.url, timeoutMs: 2000 }),
    scrobbler: new ScrobblerClient(scrobbler.url, { timeoutMs: 2000 }),
    poller: { wake: (id) => woken.push(id) },
    log: createLogger((line) => logs.push(line)),
    now: () => clock.t,
  });
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([stremio.stop(), scrobbler.stop()]);
  store.close();
});

type Reply = { status: number; headers: Headers; text: string; json: Record<string, any> };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
  const res = await fetch(origin + path, {
    method,
    redirect: "manual",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    /* html or empty */
  }
  return { status: res.status, headers: res.headers, text, json };
};

/** Run the whole configure flow with the link code and return the final cfg. */
const configure = async (options: { cfg?: string } = {}): Promise<{ setupId: string; cfg: string; manifestUrl: string; installUrl: string }> => {
  const created = await call("POST", "/stremio/api/setup", options.cfg ? { cfg: options.cfg } : {});
  assert.equal(created.status, 200);
  const setupId = created.json["setupId"] as string;
  scrobbler.pairPending = true;
  stremio.linkApproved = false;

  const pair = await call("POST", `/stremio/api/setup/${setupId}/tofu/start`);
  assert.equal(pair.json["tofu"].state, "waiting");
  assert.equal(pair.json["tofu"].userCode, "ABCD-EFGH");

  scrobbler.pairPending = false;
  clock.t += 4000; // the server honours the scrobbler's 3 s poll interval
  const approved = await call("GET", `/stremio/api/setup/${setupId}/tofu/poll`);
  assert.equal(approved.json["tofu"].state, "linked");
  assert.equal(approved.json["tofu"].username, "kalugu");

  const link = await call("POST", `/stremio/api/setup/${setupId}/stremio/link/start`);
  assert.equal(link.json["stremio"].state, "waiting");
  assert.equal(link.json["stremio"].code, "AB12");
  stremio.linkApproved = true;
  clock.t += 4000;
  const linked = await call("GET", `/stremio/api/setup/${setupId}/stremio/link/poll`);
  assert.equal(linked.json["stremio"].state, "linked");
  assert.equal(linked.json["ready"], true);

  const done = await call("POST", `/stremio/api/setup/${setupId}/finish`);
  assert.equal(done.status, 200);
  return { setupId, cfg: done.json["cfg"], manifestUrl: done.json["manifestUrl"], installUrl: done.json["installUrl"] };
};

test("the bare manifest requires configuration and allows every origin", async () => {
  const res = await call("GET", "/stremio/manifest.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.json["behaviorHints"].configurationRequired, true);
  assert.equal(res.json["behaviorHints"].configurable, true);
  assert.deepEqual(res.json["resources"], [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }]);
  assert.deepEqual(res.json["types"], ["movie", "series"]);
  assert.deepEqual(res.json["catalogs"], []);
  for (const field of ["id", "name", "description", "version"]) assert.equal(typeof res.json[field], "string", field);
});

test("health is 200 and reveals nothing", async () => {
  const res = await call("GET", "/stremio/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { status: "ok" });
});

test("the configure page is HTML with a nonce-bound CSP and no caching", async () => {
  const res = await call("GET", "/stremio/configure");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(res.text.includes(`<script nonce="${nonce}">`));
  assert.ok(csp.includes("frame-ancestors 'none'") && csp.includes("default-src 'none'"));
  assert.ok(res.text.includes('id="app"'));
  assert.ok(res.text.includes("Install"));
});

test("paths outside the prefix, the root and CORS preflight", async () => {
  assert.equal((await call("GET", "/manifest.json")).status, 404);
  assert.equal((await call("GET", "/stremiox/manifest.json")).status, 404);
  const root = await call("GET", "/stremio/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/stremio/configure");
  const preflight = await call("OPTIONS", "/stremio/anything/manifest.json");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});

test("configure flow: link TofuTracker, sign in with a Stremio link code, install", async () => {
  const { cfg, manifestUrl, installUrl, setupId } = await configure();
  assert.match(cfg, /^[A-Za-z0-9_-]{44}$/);
  assert.equal(manifestUrl, `${BASE}/${cfg}/manifest.json`);
  assert.equal(installUrl, `stremio://scrobble.example/stremio/${cfg}/manifest.json`);
  assert.equal(store.getSetup(setupId, clock.t), null, "setup is consumed");

  const manifest = await call("GET", `/stremio/${cfg}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json["name"], "TofuTracker");
  assert.equal(manifest.json["behaviorHints"].configurationRequired, false);
  assert.equal(manifest.headers.get("access-control-allow-origin"), "*");

  // Stored credentials are encrypted and bound to the account.
  const row = store.db.prepare("select * from account").get() as Record<string, string>;
  assert.ok(!JSON.stringify(row).includes("tok-secret-1") && !JSON.stringify(row).includes("AK1"));
  assert.equal(open(keys, row["tofu_token_enc"] as string, aad(row["id"] as string, "tofu_token")), "tok-secret-1");
  assert.equal(open(keys, row["stremio_auth_enc"] as string, aad(row["id"] as string, "stremio_auth")), "AK1");
  assert.equal(makeCfg(keys, row["id"] as string), cfg);
  assert.equal(store.db.prepare("select count(*) as n from setup").get()?.["n"], 0);
});

test("subtitles requests answer with an empty list and wake the poller", async () => {
  const { cfg } = await configure();
  const withExtra = await call("GET", `/stremio/${cfg}/subtitles/series/tt0903747%3A1%3A2/videoHash%3Dabc%26videoSize%3D123.json`);
  assert.equal(withExtra.status, 200);
  assert.deepEqual(withExtra.json["subtitles"], []);
  assert.equal(withExtra.headers.get("access-control-allow-origin"), "*");
  const plain = await call("GET", `/stremio/${cfg}/subtitles/movie/tt0111161.json`);
  assert.deepEqual(plain.json["subtitles"], []);
  assert.equal(woken.length, 2);
  assert.equal(woken[0], woken[1]);

  const forged = await call("GET", `/stremio/${"A".repeat(44)}/subtitles/movie/tt0111161.json`);
  assert.deepEqual(forged.json["subtitles"], []);
  assert.equal(woken.length, 2, "an unknown account does not wake anything");
});

test("unknown or forged addon links get 404 manifests and no page", async () => {
  const { cfg } = await configure();
  const forged = cfg.slice(0, 22) + "A".repeat(22);
  assert.equal((await call("GET", `/stremio/${forged}/manifest.json`)).status, 404);
  assert.equal((await call("GET", `/stremio/${forged}/configure`)).status, 404);
  assert.equal((await call("GET", `/stremio/${"B".repeat(44)}/manifest.json`)).status, 404);
  assert.equal((await call("GET", `/stremio/short/manifest.json`)).status, 404);
});

test("the manifest name reflects what the account needs", async () => {
  const { cfg } = await configure();
  const id = (store.db.prepare("select id from account").get() as { id: string }).id;
  store.setStatus(id, "needs_stremio_signin", clock.t);
  assert.match((await call("GET", `/stremio/${cfg}/manifest.json`)).json["name"], /sign in to Stremio/);
  store.setStatus(id, "needs_tofutracker_relink", clock.t);
  assert.match((await call("GET", `/stremio/${cfg}/manifest.json`)).json["name"], /link your account/);
  assert.equal(woken.length, 0);
  await call("GET", `/stremio/${cfg}/subtitles/movie/tt1.json`);
  assert.equal(woken.length, 0, "a paused account is not woken");
});

test("the manage page re-links a broken account in place and keeps the addon URL", async () => {
  const first = await configure();
  const id = (store.db.prepare("select id from account").get() as { id: string }).id;
  store.setStatus(id, "needs_stremio_signin", clock.t);

  const page = await call("GET", `/stremio/${first.cfg}/configure`);
  assert.equal(page.status, 200);
  const created = await call("POST", "/stremio/api/setup", { cfg: first.cfg });
  assert.equal(created.json["account"].status, "needs_stremio_signin");
  assert.equal(created.json["tofu"].state, "linked", "the working half is already linked");
  assert.equal(created.json["stremio"].state, "idle");
  assert.equal(created.json["ready"], false);

  const setupId = created.json["setupId"] as string;
  assert.equal((await call("POST", `/stremio/api/setup/${setupId}/finish`)).status, 409);
  const login = await call("POST", `/stremio/api/setup/${setupId}/stremio/login`, { email: "me@example.com", password: "correct" });
  assert.equal(login.json["ready"], true);
  const done = await call("POST", `/stremio/api/setup/${setupId}/finish`);
  assert.equal(done.json["cfg"], first.cfg);
  const account = store.getAccount(id);
  assert.equal(account?.status, "ok");
  assert.equal(store.db.prepare("select count(*) as n from account").get()?.["n"], 1);
});

test("signing in again as the same Stremio user reuses their account", async () => {
  const first = await configure();
  const second = await configure();
  assert.equal(second.cfg, first.cfg);
  assert.equal(store.countAccounts(), 1);
});

test("email and password sign-in: wrong password is 401 and not stored", async () => {
  const { setupId } = await configure().then(() => ({ setupId: "" }));
  assert.equal(setupId, "");
  const created = await call("POST", "/stremio/api/setup", {});
  const id = created.json["setupId"] as string;
  const bad = await call("POST", `/stremio/api/setup/${id}/stremio/login`, { email: "me@example.com", password: "wrong" });
  assert.equal(bad.status, 401);
  assert.equal(bad.json["error"], "wrong_credentials");
  const good = await call("POST", `/stremio/api/setup/${id}/stremio/login`, { email: "me@example.com", password: "correct" });
  assert.equal(good.json["stremio"].state, "linked");
  assert.equal((await call("POST", `/stremio/api/setup/${id}/stremio/login`, { email: "", password: "x" })).status, 400);
});

test("pasted auth key is verified against Stremio before it is accepted", async () => {
  const id = (await call("POST", "/stremio/api/setup", {})).json["setupId"] as string;
  const bad = await call("POST", `/stremio/api/setup/${id}/stremio/authkey`, { authKey: "not-a-valid-key" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json["error"], "invalid_auth_key");
  assert.equal((await call("POST", `/stremio/api/setup/${id}/stremio/authkey`, { authKey: "x" })).status, 400);
  const good = await call("POST", `/stremio/api/setup/${id}/stremio/authkey`, { authKey: "AK1" });
  assert.equal(good.json["stremio"].state, "linked");
});

test("a denied TofuTracker link is reported", async () => {
  const id = (await call("POST", "/stremio/api/setup", {})).json["setupId"] as string;
  await call("POST", `/stremio/api/setup/${id}/tofu/start`);
  scrobbler.pairDenied = true;
  clock.t += 4000;
  const res = await call("GET", `/stremio/api/setup/${id}/tofu/poll`);
  assert.equal(res.json["tofu"].state, "denied");
});

test("unlinking deletes the account and its addon URL stops working", async () => {
  const { cfg } = await configure();
  const res = await call("POST", `/stremio/api/account/${cfg}/unlink`, {});
  assert.equal(res.status, 200);
  assert.equal(store.countAccounts(), 0);
  assert.equal((await call("GET", `/stremio/${cfg}/manifest.json`)).status, 404);
  assert.equal((await call("POST", `/stremio/api/account/${cfg}/unlink`, {})).status, 404);
});

test("the setup API is same-origin JSON only", async () => {
  const foreign = await call("POST", "/stremio/api/setup", {}, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const same = await call("POST", "/stremio/api/setup", {}, { origin: "https://scrobble.example" });
  assert.equal(same.status, 200);
  const form = await fetch(`${origin}/stremio/api/setup`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  assert.equal(form.status, 415);
  const huge = await call("POST", "/stremio/api/setup", { pad: "x".repeat(20_000) });
  assert.equal(huge.status, 413);
  assert.equal((await call("GET", "/stremio/api/setup/nope/tofu/poll")).status, 404);
  assert.equal((await call("POST", "/stremio/api/setup", { cfg: "A".repeat(44) })).status, 404);
});

test("password attempts are rate limited", async () => {
  const id = (await call("POST", "/stremio/api/setup", {})).json["setupId"] as string;
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await call("POST", `/stremio/api/setup/${id}/stremio/login`, { email: "a@b.c", password: "wrong" })).status);
  assert.equal(statuses[0], 401);
  assert.equal(statuses.at(-1), 429);
});

test("no secret ever reaches the API responses or the logs", async () => {
  const secrets = ["tok-secret-1", "AK1", "correct", "D".repeat(43)];
  const transcript: string[] = [];
  const created = await call("POST", "/stremio/api/setup", {});
  transcript.push(created.text);
  const id = created.json["setupId"] as string;
  scrobbler.pairPending = false;
  transcript.push((await call("POST", `/stremio/api/setup/${id}/tofu/start`)).text);
  clock.t += 4000;
  transcript.push((await call("GET", `/stremio/api/setup/${id}/tofu/poll`)).text);
  transcript.push((await call("POST", `/stremio/api/setup/${id}/stremio/login`, { email: "me@example.com", password: "correct" })).text);
  const done = await call("POST", `/stremio/api/setup/${id}/finish`);
  transcript.push(done.text, ...logs);
  await call("GET", `/stremio/${done.json["cfg"]}/manifest.json`);
  await call("GET", `/stremio/${done.json["cfg"]}/subtitles/movie/tt1.json`);
  transcript.push(...logs);
  for (const secret of secrets) assert.ok(!transcript.join("\n").includes(secret), `leaked ${secret.slice(0, 4)}…`);
  assert.ok(!logs.join("\n").includes(done.json["cfg"] as string), "the cfg is not logged either");
});
