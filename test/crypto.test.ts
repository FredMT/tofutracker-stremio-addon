import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCfg, parseCfg } from "../src/cfg.ts";
import { ConfigError, loadConfig, parseCredsKey } from "../src/config.ts";
import { aad, deriveKeys, open, randomId, seal, stremioUserHash } from "../src/crypto.ts";

const keys = deriveKeys(Buffer.alloc(32, 7));
const otherKeys = deriveKeys(Buffer.alloc(32, 8));

test("seal and open round trip", () => {
  const sealed = seal(keys, "stremio-auth-key-123", aad("acct", "stremio_auth"));
  assert.ok(sealed.startsWith("v1."));
  assert.ok(!sealed.includes("stremio-auth-key-123"));
  assert.equal(open(keys, sealed, aad("acct", "stremio_auth")), "stremio-auth-key-123");
});

test("every seal uses a fresh IV", () => {
  assert.notEqual(seal(keys, "same", "a"), seal(keys, "same", "a"));
});

test("a ciphertext fails to open under another key, another owner, or after tampering", () => {
  const sealed = seal(keys, "secret", aad("acct-1", "tofu_token"));
  assert.throws(() => open(otherKeys, sealed, aad("acct-1", "tofu_token")));
  assert.throws(() => open(keys, sealed, aad("acct-2", "tofu_token")));
  assert.throws(() => open(keys, sealed, aad("acct-1", "stremio_auth")));
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("AA") ? "BB" : "AA");
  assert.throws(() => open(keys, tampered, aad("acct-1", "tofu_token")));
  assert.throws(() => open(keys, "v2.abc", "x"));
  assert.throws(() => open(keys, "v1.abc", "x"));
});

test("cfg round trip: 44 url-safe chars that carry only an account id and a MAC", () => {
  const id = randomId(16);
  const cfg = makeCfg(keys, id);
  assert.match(cfg, /^[A-Za-z0-9_-]{44}$/);
  assert.equal(parseCfg(keys, cfg), id);
});

test("cfg is rejected when forged, truncated, re-keyed or re-pointed at another account", () => {
  const id = randomId(16);
  const cfg = makeCfg(keys, id);
  assert.equal(parseCfg(otherKeys, cfg), null);
  assert.equal(parseCfg(keys, cfg.slice(1)), null);
  assert.equal(parseCfg(keys, cfg + "A"), null);
  assert.equal(parseCfg(keys, randomId(16) + cfg.slice(22)), null);
  assert.equal(parseCfg(keys, id + "A".repeat(22)), null);
  assert.equal(parseCfg(keys, "../".repeat(15)), null);
  assert.equal(parseCfg(keys, ""), null);
});

test("stremio user hash is stable, keyed and does not contain the id", () => {
  assert.equal(stremioUserHash(keys, "u1"), stremioUserHash(keys, "u1"));
  assert.notEqual(stremioUserHash(keys, "u1"), stremioUserHash(otherKeys, "u1"));
  assert.ok(!stremioUserHash(keys, "u1").includes("u1"));
});

test("STREMIO_CREDS_KEY accepts 32 bytes as hex or base64 and nothing else", () => {
  const raw = Buffer.alloc(32, 9);
  assert.deepEqual(parseCredsKey(raw.toString("hex")), raw);
  assert.deepEqual(parseCredsKey(raw.toString("base64")), raw);
  for (const bad of [undefined, "", "short", "ab".repeat(31), "zz".repeat(32), Buffer.alloc(16).toString("base64")]) {
    assert.throws(() => parseCredsKey(bad), ConfigError);
  }
});

test("config defaults", () => {
  const config = loadConfig({ STREMIO_CREDS_KEY: "ab".repeat(32) });
  assert.equal(config.publicUrl.href, "https://scrobble.tofutracker.com/stremio");
  assert.equal(config.basePath, "/stremio");
  assert.equal(config.scrobblerUrl, "http://scrobbler:8080");
  assert.equal(config.dataDir, "/data");
  assert.equal(config.port, 7000);
  assert.equal(loadConfig({ STREMIO_CREDS_KEY: "ab".repeat(32), PUBLIC_URL: "https://x.example/", SCROBBLER_URL: "http://s:1/" }).basePath, "");
});
