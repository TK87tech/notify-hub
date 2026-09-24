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

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required - see backend/.env.example"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  SERVICE_KEY: z.string().min(8, "SERVICE_KEY must be at least 8 characters"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
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
