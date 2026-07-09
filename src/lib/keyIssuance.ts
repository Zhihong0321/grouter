import { randomBytes, createHash } from "node:crypto";

export interface IssuedKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Generates a new client key using the admin-configured brand prefix. Plaintext is returned once -- callers must not persist it. */
export function issueKey(keyPrefix: string): IssuedKey {
  const random = randomBytes(32).toString("base64url");
  const plaintext = `sk-${keyPrefix}-${random}`;
  return {
    plaintext,
    hash: hashKey(plaintext),
    prefix: plaintext.slice(0, `sk-${keyPrefix}-`.length + 12),
  };
}
