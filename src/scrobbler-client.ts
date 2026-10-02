import { MAX_EVENTS_PER_REQUEST, type ClientEvent, type ClientInfo } from "./events.ts";

// Client for the scrobbler: pairing (contract C2) and events (contract C1).

export type PairStart = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalS: number;
  expiresInS: number;
};

export type PairPoll =
  | { status: "pending" | "expired" | "denied" }
  | { status: "approved"; token: string; connectionId: string | null; username: string | null };

export type SendResult =
  | { kind: "accepted" }
  /** 401: the token is unknown or revoked. Stop sending and ask the user to link again. */
  | { kind: "unauthorized" }
  /** 400: the scrobbler rejected the body. Retrying the same body will not help. */
  | { kind: "rejected"; status: number }
  /** 413: send fewer events. */
  | { kind: "too_large" }
  /** 429, 5xx or a network failure: retry later. */
  | { kind: "retry"; afterMs: number | null; reason: string };

export class ScrobblerError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export class ScrobblerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async pairStart(label: string): Promise<PairStart> {
    const body = await this.json("/v1/pair/start", { adapter: "stremio", label });
    const deviceCode = str(body["deviceCode"]);
    const userCode = str(body["userCode"]);
    const verificationUrl = str(body["verificationUrl"]);
    if (!deviceCode || !userCode || !verificationUrl) throw new ScrobblerError("pair/start reply is incomplete");
    return {
      deviceCode,
      userCode,
      verificationUrl,
      intervalS: typeof body["interval"] === "number" ? Math.max(1, body["interval"]) : 3,
      expiresInS: typeof body["expiresIn"] === "number" ? body["expiresIn"] : 600,
    };
  }

  async pairPoll(deviceCode: string): Promise<PairPoll> {
    const body = await this.json("/v1/pair/poll", { deviceCode });
    switch (body["status"]) {
      case "pending":
      case "expired":
      case "denied":
        return { status: body["status"] };
      case "approved": {
        const token = str(body["token"]);
        if (!token) throw new ScrobblerError("pair/poll approved without a token");
        return { status: "approved", token, connectionId: str(body["connectionId"]), username: str(body["username"]) };
      }
      default:
        throw new ScrobblerError("pair/poll reply has an unknown status");
    }
  }

  async postEvents(token: string, client: ClientInfo, events: ClientEvent[]): Promise<SendResult> {
    if (events.length === 0 || events.length > MAX_EVENTS_PER_REQUEST) {
      throw new ScrobblerError(`a request carries 1..${MAX_EVENTS_PER_REQUEST} events`);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ client, events }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      return { kind: "retry", afterMs: null, reason: error instanceof Error ? error.message : "network error" };
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 202 || response.status === 200) return { kind: "accepted" };
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 413) return { kind: "too_large" };
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      return { kind: "retry", afterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null, reason: "429" };
    }
    if (response.status >= 500) return { kind: "retry", afterMs: null, reason: `HTTP ${response.status}` };
    return { kind: "rejected", status: response.status };
  }

  private async json(path: string, payload: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new ScrobblerError(error instanceof Error ? error.message : "scrobbler unreachable");
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body)) throw new ScrobblerError(`scrobbler ${path} answered HTTP ${response.status}`);
    return body;
  }
}
