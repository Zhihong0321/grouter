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
  SUBROUTER_SESSION: z.string().min(1).optional(),
  SUBROUTER_USER_ID: z.string().min(1).optional(),
  SUBROUTER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  SUBROUTER_SYNC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  SUBROUTER_QUOTA_PER_USD: z.coerce.number().int().positive().default(500000),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
