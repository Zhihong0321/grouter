import { randomBytes, createHash } from "node:crypto";
import { env } from "../config/env.js";

export interface IssuedKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Generates a new client key. Plaintext is returned once -- callers must not persist it. */
export function issueKey(): IssuedKey {
  const random = randomBytes(32).toString("base64url");
  const plaintext = `sk-${env.KEY_PREFIX}-${random}`;
  return {
    plaintext,
    hash: hashKey(plaintext),
    prefix: plaintext.slice(0, `sk-${env.KEY_PREFIX}-`.length + 12),
  };
}
