import { parseLibraryItem, parseMetaEntries, type LibraryItem } from "./library.ts";

// Client for the unofficial Stremio API. Shapes were taken from stremio-core
// (src/types/api/{request,response}.rs) and the error shapes were checked
// against the live API with dummy input; see README "Stremio API notes".

export type StremioErrorKind =
  /** The auth key is not accepted (revoked, logged out, expired). Needs a fresh sign-in. */
  | "session"
  /** Email or password rejected. */
  | "credentials"
  /** A link code that Stremio does not (yet) know: not approved, expired or never issued. */
  | "pending"
  /** Network failure, timeout, HTTP 5xx: retry later. */
  | "transport"
  /** The reply did not look like the API we coded against. */
  | "protocol"
  /** Any other error object returned by the API. */
  | "api";

export class StremioError extends Error {
  readonly kind: StremioErrorKind;
  readonly apiCode: number | null;
  constructor(kind: StremioErrorKind, message: string, apiCode: number | null = null) {
    super(message);
    this.kind = kind;
    this.apiCode = apiCode;
  }
}

export type LinkCode = { code: string; link: string; qrcode: string | null };
export type StremioUser = { id: string | null; email: string | null };

export type StremioApiOptions = {
  apiUrl: string;
  linkUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
};

const LIBRARY_COLLECTION = "libraryItem";
/** Library items requested per `datastoreGet`. */
export const GET_CHUNK = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class StremioApi {
  private readonly options: Required<StremioApiOptions>;

  constructor(options: StremioApiOptions) {
    this.options = {
      fetch: globalThis.fetch,
      timeoutMs: 15_000,
      userAgent: "tofutracker-stremio-addon",
      ...options,
    };
  }

  /** Email + password. The password is sent once and not kept. */
  async login(email: string, password: string): Promise<{ authKey: string; user: StremioUser }> {
    const result = await this.post("/api/login", { type: "Login", email, password, facebook: false });
    const authKey = isRecord(result) && typeof result["authKey"] === "string" ? result["authKey"] : null;
    if (!authKey) throw new StremioError("protocol", "login reply has no authKey");
    const user = isRecord(result) && isRecord(result["user"]) ? result["user"] : {};
    return {
      authKey,
      user: {
        id: typeof user["_id"] === "string" ? user["_id"] : null,
        email: typeof user["email"] === "string" ? user["email"] : null,
      },
    };
  }

  /** The signed-in user (`getUser`), used to recognise an account that is already linked. */
  async getUser(authKey: string): Promise<StremioUser> {
    const result = await this.post("/api/getUser", { authKey });
    const user = isRecord(result) ? result : {};
    return {
      id: typeof user["_id"] === "string" ? user["_id"] : null,
      email: typeof user["email"] === "string" ? user["email"] : null,
    };
  }

  /** Link-code sign-in, step 1: Stremio issues a short code the user enters at `link`. */
  async linkCreate(): Promise<LinkCode> {
    const result = await this.get(`${this.options.linkUrl}/api/v2/create?type=Create`);
    const reply = isRecord(result) ? result : {};
    const code = typeof reply["code"] === "string" ? reply["code"] : null;
    const link = typeof reply["link"] === "string" ? reply["link"] : null;
    if (!code || !link) throw new StremioError("protocol", "link create reply has no code or link");
    return { code, link, qrcode: typeof reply["qrcode"] === "string" ? reply["qrcode"] : null };
  }

  /** Link-code sign-in, step 2: the auth key once the user has approved the code, else a "pending" error. */
  async linkRead(code: string): Promise<string> {
    const query = new URLSearchParams({ type: "Read", code });
    const result = await this.get(`${this.options.linkUrl}/api/v2/read?${query}`);
    const authKey = isRecord(result) && typeof result["authKey"] === "string" ? result["authKey"] : null;
    if (!authKey) throw new StremioError("protocol", "link read reply has no authKey");
    return authKey;
  }

  /** `[id -> mtimeMs]` for every library item. Cheap; also proves the auth key works. */
  async libraryMeta(authKey: string): Promise<Map<string, number>> {
    const result = await this.post("/api/datastoreMeta", { authKey, collection: LIBRARY_COLLECTION });
    if (!Array.isArray(result)) throw new StremioError("protocol", "datastoreMeta reply is not a list");
    return parseMetaEntries(result);
  }

  /** The library items with these ids. Items that do not parse are skipped. */
  async libraryGet(authKey: string, ids: string[]): Promise<LibraryItem[]> {
    const items: LibraryItem[] = [];
    for (let i = 0; i < ids.length; i += GET_CHUNK) {
      const result = await this.post("/api/datastoreGet", {
        authKey,
        collection: LIBRARY_COLLECTION,
        ids: ids.slice(i, i + GET_CHUNK),
        all: false,
      });
      if (!Array.isArray(result)) throw new StremioError("protocol", "datastoreGet reply is not a list");
      for (const raw of result) {
        const item = parseLibraryItem(raw);
        if (item) items.push(item);
      }
    }
    return items;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(`${this.options.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async get(url: string): Promise<unknown> {
    return this.request(url, { method: "GET" });
  }

  /** Every Stremio endpoint answers `{ "result": ... }` or `{ "error": { code, message } }`, normally with HTTP 200. */
  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    let payload: unknown;
    try {
      response = await this.options.fetch(url, {
        ...init,
        headers: { accept: "application/json", "user-agent": this.options.userAgent, ...init.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: "error",
      });
      payload = await response.json().catch(() => undefined);
    } catch (error) {
      throw new StremioError("transport", error instanceof Error ? error.message : "request failed");
    }
    if (isRecord(payload) && isRecord(payload["error"])) throw classifyError(payload["error"]);
    if (response.status >= 500) throw new StremioError("transport", `HTTP ${response.status}`);
    if (!response.ok || !isRecord(payload) || !("result" in payload)) {
      throw new StremioError("protocol", `unexpected reply (HTTP ${response.status})`);
    }
    return payload["result"];
  }
}

const classifyError = (error: Record<string, unknown>): StremioError => {
  const apiCode = typeof error["code"] === "number" ? error["code"] : null;
  const message = typeof error["message"] === "string" ? error["message"] : "error";
  if (error["wrongPass"] === true || apiCode === 3) return new StremioError("credentials", message, apiCode);
  if (apiCode === 101) return new StremioError("pending", message, apiCode);
  // Observed: { code: 1, message: "Session does not exist" } for an unknown auth key.
  if (apiCode === 1 || /session/i.test(message)) return new StremioError("session", message, apiCode);
  return new StremioError("api", message, apiCode);
};
