import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseLibraryItem, parseMetaEntries } from "../src/library.ts";
import { GET_CHUNK, StremioApi, StremioError } from "../src/stremio-api.ts";
import { FakeStremio, rawItem } from "./helpers.ts";

const fake = new FakeStremio();
let api: StremioApi;
before(async () => {
  await fake.start();
  api = new StremioApi({ apiUrl: fake.url, linkUrl: fake.url, timeoutMs: 2000 });
});
after(() => fake.stop());

const kind = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "no error";
  } catch (error) {
    return error instanceof StremioError ? error.kind : `other: ${String(error)}`;
  }
};

test("login returns the auth key and user; wrong credentials are classified", async () => {
  const ok = await api.login("me@example.com", "correct");
  assert.equal(ok.authKey, "AK1");
  assert.equal(ok.user.id, "stremio-user-1");
  assert.equal(await kind(api.login("me@example.com", "nope")), "credentials");
});

test("link code flow: create, pending while unapproved, auth key once approved", async () => {
  const link = await api.linkCreate();
  assert.equal(link.code, "AB12");
  assert.ok(link.link.endsWith("/AB12"));
  fake.linkApproved = false;
  assert.equal(await kind(api.linkRead(link.code)), "pending");
  fake.linkApproved = true;
  assert.equal(await api.linkRead(link.code), "AK1");
  fake.linkApproved = false;
});

test("library meta and get use the documented request bodies and parse items", async () => {
  fake.library.clear();
  fake.setItem(rawItem("tt0111161", "movie", Date.parse("2026-10-01T10:00:00Z"), { timesWatched: 1, flaggedWatched: 1 }, "Shawshank"));
  fake.setItem(rawItem("tt0903747", "series", Date.parse("2026-10-02T10:00:00Z"), { video_id: "tt0903747:1:2", timeOffset: 61_000, duration: 2_700_000 }));
  const meta = await api.libraryMeta("AK1");
  assert.equal(meta.get("tt0111161"), Date.parse("2026-10-01T10:00:00Z"));
  const items = await api.libraryGet("AK1", ["tt0111161", "tt0903747"]);
  assert.equal(items.length, 2);
  const show = items.find((i) => i.id === "tt0903747");
  assert.equal(show?.snapshot.videoId, "tt0903747:1:2");
  assert.equal(show?.snapshot.timeOffset, 61_000);
  assert.equal(items.find((i) => i.id === "tt0111161")?.snapshot.name, "Shawshank");
});

test("an unknown auth key is a session error (as observed on the live API)", async () => {
  assert.equal(await kind(api.libraryMeta("bad-key")), "session");
  assert.equal(await kind(api.libraryGet("bad-key", ["x"])), "session");
});

test("a dead server is a transport error", async () => {
  fake.down = true;
  assert.equal(await kind(api.libraryMeta("AK1")), "transport");
  fake.down = false;
});

test("ids are requested in chunks", async () => {
  fake.library.clear();
  for (let i = 0; i < GET_CHUNK + 5; i++) fake.setItem(rawItem(`tt${1000 + i}`, "movie", 1_700_000_000_000 + i));
  fake.calls.length = 0;
  const items = await api.libraryGet("AK1", [...fake.library.keys()]);
  assert.equal(items.length, GET_CHUNK + 5);
  assert.equal(fake.calls.filter((c) => c.endsWith("datastoreGet")).length, 2);
});

test("parsing ignores unknown fields and skips items that are not library items", () => {
  const good = rawItem("tt1", "movie", 1_700_000_000_000, {});
  (good["state"] as Record<string, unknown>)["someFutureField"] = { nested: true };
  good["anotherFutureField"] = 7;
  assert.equal(parseLibraryItem(good)?.id, "tt1");
  for (const bad of [null, 5, "x", [], {}, { _id: "x" }, { _id: "x", state: {}, _mtime: "not a date" }, { _id: "", state: {}, _mtime: "2026-01-01T00:00:00Z" }]) {
    assert.equal(parseLibraryItem(bad), null);
  }
  const odd = parseLibraryItem({ _id: "tt2", type: "movie", _mtime: 1_700_000_000_000, state: { timeOffset: "x", timesWatched: -3, duration: null, video_id: null, watched: "" } });
  assert.deepEqual([odd?.snapshot.timeOffset, odd?.snapshot.timesWatched, odd?.snapshot.duration, odd?.snapshot.videoId, odd?.snapshot.watched], [0, 0, 0, null, null]);
});

test("meta entries tolerate malformed rows and ISO timestamps", () => {
  const map = parseMetaEntries([["a", 1000], ["b", "2026-10-02T00:00:00Z"], ["c"], [5, 5], "x", null, ["d", "nope"]]);
  assert.deepEqual([...map.keys()], ["a", "b"]);
  assert.equal(map.get("b"), Date.parse("2026-10-02T00:00:00Z"));
  assert.equal(parseMetaEntries({ not: "a list" }).size, 0);
});
