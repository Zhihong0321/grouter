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
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
