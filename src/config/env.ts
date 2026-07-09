import { z } from "zod";

const schema = z.object({
  SUBROUTER_API_KEY: z.string().min(1),
  SUBROUTER_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(8787),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  KEY_PREFIX: z.string().default("orbit"),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
