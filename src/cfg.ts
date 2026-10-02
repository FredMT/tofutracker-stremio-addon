import { createHmac } from "node:crypto";
import { safeEqual, type Keys } from "./crypto.ts";

// An account id is 16 random bytes (22 base64url chars). The `{cfg}` path
// segment is that id followed by a truncated HMAC of it (22 chars). It names an
// account and nothing else: it carries no credentials, and a forged or mistyped
// one is rejected before the database is touched.
const ID_LENGTH = 22;
const MAC_LENGTH = 22;
const CFG_PATTERN = /^[A-Za-z0-9_-]{44}$/;

const mac = (keys: Keys, accountId: string): string =>
  createHmac("sha256", keys.mac).update(`cfg|${accountId}`).digest().subarray(0, 16).toString("base64url");

export const makeCfg = (keys: Keys, accountId: string): string => accountId + mac(keys, accountId);

/** Returns the account id, or null when the value is malformed or the MAC is wrong. */
export const parseCfg = (keys: Keys, cfg: string): string | null => {
  if (!CFG_PATTERN.test(cfg)) return null;
  const accountId = cfg.slice(0, ID_LENGTH);
  return safeEqual(cfg.slice(ID_LENGTH, ID_LENGTH + MAC_LENGTH), mac(keys, accountId)) ? accountId : null;
};
