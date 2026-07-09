import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";
const derivedKey = createHash("sha256").update(env.SESSION_SECRET).digest();

/** Encrypts an issued key for at-rest storage so the admin can retrieve it later. */
export function encryptKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptKey(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, derivedKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
