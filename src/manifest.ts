import type { AccountStatus } from "./db.ts";

// Stremio addon manifest (stremio-addon-sdk docs/api/responses/manifest.md).

export type ManifestState = AccountStatus | "unconfigured";

const NAME: Record<ManifestState, string> = {
  ok: "TofuTracker",
  unconfigured: "TofuTracker",
  needs_stremio_signin: "TofuTracker (sign in to Stremio again)",
  needs_tofutracker_relink: "TofuTracker (link your account again)",
};

export type Manifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: { name: string; types: string[]; idPrefixes: string[] }[];
  types: string[];
  idPrefixes: string[];
  catalogs: never[];
  behaviorHints: { configurable: true; configurationRequired: boolean };
};

export const buildManifest = (version: string, state: ManifestState): Manifest => ({
  id: "org.tofutracker.stremio",
  version,
  name: NAME[state],
  description:
    state === "unconfigured"
      ? "Adds what you watch in Stremio to your TofuTracker library. Open the configure page to link your accounts."
      : "Adds what you watch in Stremio to your TofuTracker library. It watches your Stremio library and never touches your streams.",
  // The subtitles resource exists only so Stremio pings us when a video opens;
  // the answer is always an empty list. All tracking comes from the library.
  resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }],
  types: ["movie", "series"],
  idPrefixes: ["tt", "kitsu"],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: state === "unconfigured" },
});
