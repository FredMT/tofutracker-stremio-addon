import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLibraryItem } from "../src/library.ts";

const raw = (type: string, state: Record<string, unknown>) => ({ _id: "tt0133093", name: "The Matrix", type, _mtime: "2026-10-02T19:01:57.376Z", removed: true, temp: true, state });

test("a movie that was never played takes its own id as the video id", () => {
  const item = parseLibraryItem(raw("movie", { video_id: "", timesWatched: 1, flaggedWatched: 0 }));
  assert.equal(item?.snapshot.videoId, "tt0133093");
  assert.equal(item?.snapshot.timesWatched, 1);
});

test("a series without a video id stays without one", () => {
  assert.equal(parseLibraryItem(raw("series", { timesWatched: 1 }))?.snapshot.videoId, null);
});

test("an explicit video id wins", () => {
  assert.equal(parseLibraryItem(raw("series", { video_id: "tt0903747:1:2" }))?.snapshot.videoId, "tt0903747:1:2");
});
