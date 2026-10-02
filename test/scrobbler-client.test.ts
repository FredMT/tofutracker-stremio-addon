import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ClientEvent } from "../src/events.ts";
import { itemRefFor } from "../src/events.ts";
import { ScrobblerClient, ScrobblerError } from "../src/scrobbler-client.ts";
import { FakeScrobbler } from "./helpers.ts";

const fake = new FakeScrobbler();
let client: ScrobblerClient;
before(async () => {
  await fake.start();
  client = new ScrobblerClient(fake.url, { timeoutMs: 2000 });
});
after(() => fake.stop());

const info = { name: "stremio-addon", version: "1.0.0", server: "Stremio" };
const event = (): ClientEvent => ({
  action: "start",
  occurredAt: "2026-10-02T14:00:00.000Z",
  sessionId: "s1",
  positionMs: 1000,
  manual: false,
  item: itemRefFor("tt0903747:1:1", "Show") as NonNullable<ReturnType<typeof itemRefFor>>,
});

test("pair start sends the stremio adapter and parses the C2 reply", async () => {
  const pair = await client.pairStart("Stremio addon");
  assert.equal(pair.userCode, "ABCD-EFGH");
  assert.equal(pair.deviceCode.length, 43);
  assert.equal(pair.intervalS, 3);
  assert.equal(pair.expiresInS, 600);
  assert.deepEqual(fake.received.at(-1)?.body, { adapter: "stremio", label: "Stremio addon" });
});

test("pair poll: pending, approved (token returned), denied", async () => {
  fake.pairPending = true;
  assert.deepEqual(await client.pairPoll("D"), { status: "pending" });
  fake.pairPending = false;
  assert.deepEqual(await client.pairPoll("D"), { status: "approved", token: "tok-secret-1", connectionId: "conn-1", username: "kalugu" });
  fake.pairDenied = true;
  assert.deepEqual(await client.pairPoll("D"), { status: "denied" });
  fake.pairDenied = false;
});

test("events: body shape, bearer token, 202 accepted", async () => {
  fake.eventsStatus = 202;
  assert.deepEqual(await client.postEvents("tok-1", info, [event()]), { kind: "accepted" });
  const last = fake.received.at(-1);
  assert.equal(last?.auth, "Bearer tok-1");
  assert.deepEqual(Object.keys(last?.body ?? {}).sort(), ["client", "events"]);
  assert.deepEqual(last?.body["client"], info);
});

test("events: 401, 400, 413, 429 with Retry-After, 500 are classified", async () => {
  const send = async (status: number, retryAfter: string | null = null) => {
    fake.eventsStatus = status;
    fake.retryAfter = retryAfter;
    return client.postEvents("t", info, [event()]);
  };
  assert.deepEqual(await send(401), { kind: "unauthorized" });
  assert.deepEqual(await send(400), { kind: "rejected", status: 400 });
  assert.deepEqual(await send(413), { kind: "too_large" });
  assert.deepEqual(await send(429, "17"), { kind: "retry", afterMs: 17_000, reason: "429" });
  assert.deepEqual(await send(429), { kind: "retry", afterMs: null, reason: "429" });
  assert.deepEqual(await send(503), { kind: "retry", afterMs: null, reason: "HTTP 503" });
  fake.eventsStatus = 202;
  fake.retryAfter = null;
});

test("events: a network failure is retryable", async () => {
  const dead = new ScrobblerClient("http://127.0.0.1:1", { timeoutMs: 500 });
  assert.equal((await dead.postEvents("t", info, [event()])).kind, "retry");
});

test("a request carries between 1 and 50 events", async () => {
  await assert.rejects(client.postEvents("t", info, []), ScrobblerError);
  await assert.rejects(client.postEvents("t", info, Array.from({ length: 51 }, event)), ScrobblerError);
});
