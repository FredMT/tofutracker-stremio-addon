import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { CinemetaClient } from "./cinemeta.ts";
import { loadConfig, ConfigError } from "./config.ts";
import { deriveKeys } from "./crypto.ts";
import { Store } from "./db.ts";
import { createLogger } from "./log.ts";
import { Poller } from "./poller.ts";
import { ScrobblerClient } from "./scrobbler-client.ts";
import { StremioApi } from "./stremio-api.ts";

const log = createLogger();

const main = async (): Promise<void> => {
  const config = loadConfig(process.env);
  const keys = deriveKeys(config.credsKey);
  const store = Store.open(config.dataDir);
  const stremio = new StremioApi({ apiUrl: config.stremioApiUrl, linkUrl: config.stremioLinkUrl });
  const scrobbler = new ScrobblerClient(config.scrobblerUrl);
  const poller = new Poller({
    store,
    stremio,
    scrobbler,
    keys,
    tuning: config.poll,
    client: { name: "stremio-addon", version: config.version, server: "Stremio" },
    log,
    cinemeta: new CinemetaClient({ baseUrl: config.cinemetaUrl, log }),
  });
  const handle = createApp({ config, store, keys, stremio, scrobbler, poller, log });
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  await new Promise<void>((resolve) => server.listen(config.port, "0.0.0.0", resolve));
  poller.start();
  log.info("listening", { port: config.port, publicUrl: config.publicUrl.href, accounts: store.countAccounts() });

  const shutdown = (signal: string): void => {
    log.info("shutting down", { signal });
    server.close();
    void poller.stop().finally(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

main().catch((error: unknown) => {
  log.error(error instanceof ConfigError ? "invalid configuration" : "fatal", { error });
  process.exit(1);
});
