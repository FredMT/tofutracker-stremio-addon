import assert from "node:assert/strict";
import { test } from "node:test";
import { itemRefFor } from "../src/events.ts";
import { parseVideoId, shiftEpisode } from "../src/ids.ts";

test("parses IMDb movie, IMDb episode, Kitsu title and Kitsu episode ids", () => {
  assert.deepEqual(parseVideoId("tt0111161"), { kind: "movie", source: "imdb", imdb: "tt0111161" });
  assert.deepEqual(parseVideoId("tt0903747:1:2"), { kind: "episode", source: "imdb", imdb: "tt0903747", season: 1, episode: 2 });
  assert.deepEqual(parseVideoId("kitsu:1376"), { kind: "movie", source: "kitsu", kitsu: 1376 });
  assert.deepEqual(parseVideoId("kitsu:1376:5"), { kind: "episode", source: "kitsu", kitsu: 1376, episode: 5 });
});

test("rejects ids from other catalogs and malformed ids", () => {
  for (const id of ["", "yt_id:abc", "local:xyz", "tt", "ttabc", "tt1:1", "tt1:a:b", "kitsu:", "kitsu:1:2:3", "tmdb:55", "tt0903747:1:2:3"]) {
    assert.equal(parseVideoId(id), null, id);
  }
});

test("shiftEpisode stays inside the season or title", () => {
  assert.equal(shiftEpisode("tt0903747:2:5", -2), "tt0903747:2:3");
  assert.equal(shiftEpisode("tt0903747:2:5", -5), null);
  assert.equal(shiftEpisode("kitsu:1376:12", -11), "kitsu:1376:1");
  assert.equal(shiftEpisode("tt0111161", 0), "tt0111161");
  assert.equal(shiftEpisode("tt0111161", -1), null);
  assert.equal(shiftEpisode("garbage", 0), null);
});

test("maps ids to the C1 item shape", () => {
  const movie = itemRefFor("tt0111161", "Shawshank");
  assert.equal(movie?.kind, "movie");
  assert.equal(movie?.ids.imdb, "tt0111161");
  assert.equal(movie?.numbering, null);

  const episode = itemRefFor("tt0903747:1:2", "Breaking Bad");
  assert.deepEqual([episode?.kind, episode?.ids.imdb, episode?.season, episode?.episode, episode?.numbering], ["episode", "tt0903747", 1, 2, "imdb"]);

  const anime = itemRefFor("kitsu:1376:5", "Cowboy Bebop");
  assert.deepEqual([anime?.kind, anime?.ids.kitsu, anime?.ids.imdb, anime?.season, anime?.episode, anime?.numbering], ["episode", 1376, null, null, 5, null]);

  assert.equal(itemRefFor("yt_id:abc", "x"), null);
});
