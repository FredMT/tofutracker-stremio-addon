// Container healthcheck: GET {PUBLIC_URL path}/health on the local port. Exit 0 when it answers 200.
const base = new URL(process.env["PUBLIC_URL"] || "https://scrobble.tofutracker.com/stremio").pathname.replace(/\/+$/, "");
const port = process.env["PORT"] || "7000";

fetch(`http://127.0.0.1:${port}${base}/health`, { signal: AbortSignal.timeout(5000) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
