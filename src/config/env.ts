import { z } from "zod";

// Note: the subrouter key/base URL and issued-key prefix are NOT here --
// they're managed at runtime via the admin dashboard (see src/lib/settings.ts),
// stored in Postgres instead of Railway env vars.
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(8787),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DEBUG_TOKEN: z.string().optional(),
  SUBROUTER_BASE_URL: z.string().url().default("https://subrouter.ai"),
  // The supplier console/session can live on a different host than the
  // OpenAI-compatible API endpoint used by an imported supplier key.
  SUBROUTER_UPSTREAM_BASE_URL: z.string().url().default("https://subrouter.ai"),
  // Anthropic-compatible APIs can live on a different origin/path from the
  // OpenAI endpoint even when they accept the same supplier key.
  SUBROUTER_ANTHROPIC_BASE_URL: z.string().url().default("https://subrouter.ai"),
  SUBROUTER_SESSION: z.string().min(1).optional(),
  SUBROUTER_USER_ID: z.string().min(1).optional(),
  SUBROUTER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SUBROUTER_SYNC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  SUBROUTER_QUOTA_PER_USD: z.coerce.number().int().positive().default(500000),
  // The proxy process performs this off-path. PostgreSQL's advisory lock in
  // the sync protects us if Railway ever runs more than one replica.
  SUBROUTER_ACTIVITY_SYNC_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  SUBROUTER_ACTIVITY_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(300),
  // Gates POST /client/accounts (public, unauthenticated self-serve signup for
  // the Tauri client app) so it can't be spammed by a bot that finds the URL.
  // Baked into the app build, not tied to any one user's session.
  CLIENT_BOOTSTRAP_SECRET: z.string().min(16),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
