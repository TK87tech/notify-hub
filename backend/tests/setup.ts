/**
 * Test environment, applied before any source file is imported.
 *
 * This exists because config/env.ts validates on import and exits the process
 * when something is missing. Without these defaults, `npm test` on a fresh
 * clone fails with "Invalid environment configuration" unless you happen to
 * have a backend/.env - and in CI the values came from the workflow file, so
 * local runs and CI runs were testing different configurations.
 *
 * Real environment variables still win, so CI can override anything here.
 */

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL ??= "silent";
process.env.JWT_SECRET ??= "test-secret-at-least-16-chars";
process.env.SERVICE_KEY ??= "test-service-key";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.APP_URL ??= "http://localhost:5173";
process.env.BREVO_API_KEY ??= "";
process.env.EMAIL_FROM ??= "no-reply@example.com";