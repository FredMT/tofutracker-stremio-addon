import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWatchedField, watchedDelta, watchedIds } from "../src/watched.ts";
import { watchedField } from "./helpers.ts";

// Both literals come from the unit tests of stremio-core's stremio-watched-bitfield crate.
const CORE_FIELD_1 = "tt2934286:1:5:5:eJyTZwAAAEAAIA==";
const CORE_FIELD_2 = "tt7767422:3:8:24:eJz7//8/AAX9Av4=";

test("decodes the field format used by stremio-core", () => {
  const parsed = parseWatchedField(CORE_FIELD_1);
  assert.equal(parsed?.anchorVideo, "tt2934286:1:5");
  assert.equal(parsed?.anchorLength, 5);
  assert.deepEqual([...(parsed?.bits ?? [])], [31, 0]);
});

test("names the watched videos of a stremio-core field", () => {
  const { ids, unresolved } = watchedIds(CORE_FIELD_1);
  assert.deepEqual([...ids].sort(), [1, 2, 3, 4, 5].map((e) => `tt2934286:1:${e}`));
  assert.equal(unresolved, 0);
});

test("bits that fall into an earlier season cannot be named", () => {
  const { ids, unresolved } = watchedIds(CORE_FIELD_2);
  assert.deepEqual([...ids].sort(), [1, 2, 3, 4, 5, 6, 7, 8].map((e) => `tt7767422:3:${e}`).sort());
  assert.equal(unresolved, 16);
});

test("malformed fields decode to nothing instead of throwing", () => {
  for (const raw of ["", "undefined", "a:b", "tt1:1:notbase64!!", "tt1:x:eJyTZwAAAEAAIA==", "tt1:1:AAAA"]) {
    assert.equal(watchedIds(raw).ids.size, 0, raw);
  }
});

test("movie and anime fields", () => {
  assert.deepEqual([...watchedIds(watchedField("tt0111161", 1, [0])).ids], ["tt0111161"]);
  assert.deepEqual([...watchedIds(watchedField("kitsu:1376:3", 3, [0, 2])).ids].sort(), ["kitsu:1376:1", "kitsu:1376:3"]);
});

test("delta reports newly watched videos", () => {
  const before = watchedField("tt1:1:2", 2, [0, 1]);
  const after = watchedField("tt1:1:4", 4, [0, 1, 3]);
  const delta = watchedDelta(before, after);
  assert.deepEqual(delta.added, ["tt1:1:4"]);
  assert.equal(delta.unmarked, false);
});

test("a field appearing for the first time adds every set bit", () => {
  const delta = watchedDelta(null, watchedField("tt1:1:3", 3, [0, 1, 2]));
  assert.deepEqual(delta.added.sort(), ["tt1:1:1", "tt1:1:2", "tt1:1:3"]);
});

test("un-marking the last watched video is detected", () => {
  const before = watchedField("tt1:1:3", 3, [0, 1, 2]);
  const after = watchedField("tt1:1:2", 2, [0, 1]);
  assert.equal(watchedDelta(before, after).unmarked, true);
  assert.equal(watchedDelta(before, null).unmarked, true);
});

test("the anchor moving to a later season is not an un-mark", () => {
  const before = watchedField("tt1:1:3", 3, [0, 1, 2]);
  // Season 2 episode 1 watched; the season 1 bits are no longer nameable, but still set.
  const after = watchedField("tt1:2:1", 4, [0, 1, 2, 3]);
  const delta = watchedDelta(before, after);
  assert.equal(delta.unmarked, false);
  assert.deepEqual(delta.added, ["tt1:2:1"]);
});
