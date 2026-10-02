import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type Keys = { enc: Buffer; mac: Buffer };

const derive = (master: Buffer, info: string): Buffer =>
  Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));

/** Two independent subkeys from the one operator-supplied secret. */
export const deriveKeys = (master: Buffer): Keys => ({
  enc: derive(master, "tofutracker-stremio-addon/aes-256-gcm/v1"),
  mac: derive(master, "tofutracker-stremio-addon/hmac-sha256/v1"),
});

const VERSION_PREFIX = "v1.";

/**
 * AES-256-GCM. The output is `v1.` + base64url(iv | tag | ciphertext). `aad`
 * binds a ciphertext to where it belongs (account id + column), so a value
 * copied into another row fails to open.
 */
export const seal = (keys: Keys, plaintext: string, aad: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
};

export const open = (keys: Keys, sealed: string, aad: string): string => {
  if (!sealed.startsWith(VERSION_PREFIX)) throw new Error("unsupported ciphertext version");
  const raw = Buffer.from(sealed.slice(VERSION_PREFIX.length), "base64url");
  if (raw.length < 12 + 16) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", keys.enc, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
};

export const randomId = (bytes = 16): string => randomBytes(bytes).toString("base64url");

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Associated data for a stored secret: ties it to its owner (`account id`, `setup:<id>`) and column. */
export const aad = (scope: string, field: string): string => `${scope}|${field}`;

/** A stable, non-reversible handle for a Stremio user id, so the same person is not linked twice. */
export const stremioUserHash = (keys: Keys, userId: string): string =>
  createHmac("sha256", keys.mac).update(`stremio-user|${userId}`).digest("hex");
