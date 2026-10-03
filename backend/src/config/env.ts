/**
 * Environment configuration, validated once at startup.
 *
 * The point of validating here rather than reading process.env everywhere:
 * a missing JWT_SECRET should stop the server on boot with a clear message,
 * not fail on the first request at three in the morning.
 */

// Loads backend/.env into process.env. Must be the first import here, because
// the schema below reads process.env the moment this module is evaluated.
// Prisma's CLI reads .env on its own; the app does not, hence this line.
// It never overwrites a variable that is already set, so real environment
// variables on Render still win over the local file.
import "dotenv/config";

import { z } from "zod";

/**
 * "1,2,3" -> ["1","2","3"]. Empty means "no extra origins", not "no CORS":
 * an empty APP_URL list would lock the browser out entirely.
 */
const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().default("http://localhost:5173"),

  /**
   * Extra browser origins allowed by CORS and by the Socket.IO handshake.
   * Needed because the frontend lives on Vercel and the API on Render, so the
   * production origin is not APP_URL.
   */
  CORS_ORIGINS: csv([]),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required - see backend/.env.example"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  SERVICE_KEY: z.string().min(8, "SERVICE_KEY must be at least 8 characters"),

  BREVO_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default("no-reply@example.com"),

  /**
   * Brevo's free tier sends 300 emails a day. The email worker runs with a
   * short-window limiter and this hard daily ceiling on top of it, so a burst
   * cannot silently push us over and get the account throttled. See
   * docs/RUNBOOK.md for the arithmetic.
   */
  EMAIL_DAILY_LIMIT: z.coerce.number().int().positive().default(300),
  EMAIL_RATE_MAX: z.coerce.number().int().positive().default(20),
  EMAIL_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  FCM_PROJECT_ID: z.string().default(""),
  FCM_CLIENT_EMAIL: z.string().default(""),
  FCM_PRIVATE_KEY: z.string().default(""),

  SENTRY_DSN: z.string().default(""),

  // "silent" is pino's own level, kept here so LOG_LEVEL=silent is a valid
  // thing to put in a .env when somebody wants a completely quiet run.
  LOG_LEVEL: z
    .enum(["silent", "fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    console.error("\nInvalid environment configuration:\n");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    console.error("\nCopy backend/.env.example to backend/.env and fill it in.\n");
    process.exit(1);
  }

  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/**
 * Every origin the browser is allowed to talk to us from. APP_URL always goes
 * first so a single-origin local setup needs no extra configuration.
 */
export const allowedOrigins = [env.APP_URL, ...env.CORS_ORIGINS];