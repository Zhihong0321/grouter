import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { issueKey, hashKey } from "../../lib/keyIssuance.js";
import { encryptKey, decryptKey } from "../../lib/keyCrypto.js";
import { extractApiKey, lookupKeyByHash } from "../../lib/keyAuth.js";
import { checkRateLimit } from "../../lib/rateLimit.js";
import { env } from "../../config/env.js";

interface CreateAccountBody {
  username: string;
  recoveryPassword: string;
}

interface RecoverAccountBody {
  recoveryPassword: string;
}

const SIGNUP_RATE_LIMIT_PER_MINUTE = 5;

function validateUsername(username: unknown): string | null {
  if (typeof username !== "string") return null;
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return null;
  return trimmed;
}

/** User-typed per product decision -- enforce a minimum length since it's the sole account credential. */
function validateRecoveryPassword(recoveryPassword: unknown): string | null {
  if (typeof recoveryPassword !== "string") return null;
  if (recoveryPassword.length < 10 || recoveryPassword.length > 128) return null;
  return recoveryPassword;
}

async function requireBootstrapSecret(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = request.headers["x-bootstrap-secret"];
  if (secret !== env.CLIENT_BOOTSTRAP_SECRET) {
    reply.code(401).send({ error: "Missing or invalid bootstrap secret" });
  }
}

const clientAccountsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: CreateAccountBody }>(
    "/client/accounts",
    { preHandler: requireBootstrapSecret },
    async (request, reply) => {
      const withinRateLimit = await checkRateLimit(app.redis, `client-signup:${request.ip}`, SIGNUP_RATE_LIMIT_PER_MINUTE);
      if (!withinRateLimit) {
        return reply.code(429).send({ error: "Too many signups from this address -- try again shortly" });
      }

      const username = validateUsername(request.body?.username);
      if (!username) {
        return reply.code(400).send({ error: "username must be 2-40 characters" });
      }
      const recoveryPassword = validateRecoveryPassword(request.body?.recoveryPassword);
      if (!recoveryPassword) {
        return reply.code(400).send({ error: "recoveryPassword must be 10-128 characters" });
      }

      const recoveryHash = hashKey(recoveryPassword);

      let accountId: string;
      try {
        const { rows } = await app.pg.query(
          "INSERT INTO reseller_client_accounts (username, recovery_hash) VALUES ($1,$2) RETURNING id",
          [username, recoveryHash],
        );
        accountId = rows[0].id;
      } catch (err: any) {
        if (err?.code === "23505") {
          return reply.code(409).send({ error: "That recovery password is already in use -- choose a different one" });
        }
        throw err;
      }

      const keyPrefix = await app.settingsCache.getKeyPrefix();
      const issued = issueKey(keyPrefix);
      const ciphertext = encryptKey(issued.plaintext);

      await app.pg.query(
        `INSERT INTO reseller_api_keys (name, key_hash, key_prefix, key_ciphertext, unlimited, account_id)
         VALUES ($1,$2,$3,$4,true,$5)`,
        [`client:${username}`, issued.hash, issued.prefix, ciphertext, accountId],
      );

      reply.code(201).send({ username, key: issued.plaintext });
    },
  );

  app.post<{ Body: RecoverAccountBody }>("/client/accounts/recover", async (request, reply) => {
    const recoveryPassword = validateRecoveryPassword(request.body?.recoveryPassword);
    if (!recoveryPassword) {
      return reply.code(400).send({ error: "recoveryPassword must be 10-128 characters" });
    }

    const recoveryHash = hashKey(recoveryPassword);
    const { rows: accountRows } = await app.pg.query(
      "SELECT id, username FROM reseller_client_accounts WHERE recovery_hash = $1",
      [recoveryHash],
    );
    if (accountRows.length === 0) {
      return reply.code(401).send({ error: "Invalid recovery password" });
    }
    const account = accountRows[0];

    const { rows: keyRows } = await app.pg.query(
      `SELECT * FROM reseller_api_keys WHERE account_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [account.id],
    );
    if (keyRows.length === 0) {
      return reply.code(404).send({ error: "No active key for this account" });
    }
    const keyRow = keyRows[0];

    return {
      username: account.username,
      key: decryptKey(keyRow.key_ciphertext),
      balanceCents: keyRow.unlimited ? null : Number(keyRow.budget_cents) - Number(keyRow.spent_cents),
    };
  });

  app.get("/client/accounts/me", async (request, reply) => {
    const recoveryPasswordHeader = request.headers["x-recovery-password"];

    let keyRow: any;
    let username: string;

    if (typeof recoveryPasswordHeader === "string" && recoveryPasswordHeader.length > 0) {
      const recoveryHash = hashKey(recoveryPasswordHeader);
      const { rows: accountRows } = await app.pg.query(
        "SELECT id, username FROM reseller_client_accounts WHERE recovery_hash = $1",
        [recoveryHash],
      );
      if (accountRows.length === 0) {
        return reply.code(401).send({ error: "Invalid recovery password" });
      }
      const { rows: keyRows } = await app.pg.query(
        `SELECT * FROM reseller_api_keys WHERE account_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
        [accountRows[0].id],
      );
      if (keyRows.length === 0) {
        return reply.code(404).send({ error: "No active key for this account" });
      }
      keyRow = keyRows[0];
      username = accountRows[0].username;
    } else {
      const apiKeyHeader = extractApiKey(request.headers);
      if (!apiKeyHeader) {
        return reply.code(401).send({ error: "Missing x-recovery-password, x-api-key, or Authorization header" });
      }
      const record = await lookupKeyByHash(app.pg, app.redis, hashKey(apiKeyHeader));
      if (!record || record.status !== "active") {
        return reply.code(401).send({ error: "Invalid or revoked API key" });
      }
      const { rows } = await app.pg.query(
        `SELECT ak.*, ca.username FROM reseller_api_keys ak
         JOIN reseller_client_accounts ca ON ca.id = ak.account_id
         WHERE ak.id = $1`,
        [record.id],
      );
      if (rows.length === 0) {
        return reply.code(404).send({ error: "This key is not linked to a client account" });
      }
      keyRow = rows[0];
      username = rows[0].username;
    }

    return {
      username,
      unlimited: keyRow.unlimited,
      balanceCents: keyRow.unlimited ? null : Number(keyRow.budget_cents) - Number(keyRow.spent_cents),
      spentCents: Number(keyRow.spent_cents),
    };
  });
};

export default clientAccountsRoutes;
