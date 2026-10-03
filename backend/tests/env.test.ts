/**
 * Production-only guard against shipping the example secrets.
 *
 * The values live in backend/.env.example so a new contributor can copy that
 * file and run the stack without generating anything. That is the right default
 * for local development and the wrong one for production, where both are
 * published: JWT_SECRET lets anybody forge a session, and SERVICE_KEY opens
 * /internal/queue-stats and the alert script.
 *
 * These call `parseEnv` rather than importing the module's side effects, because
 * `load()` exits the process on bad config and that is untestable. The two things
 * this must not do are fail local development, and quietly stop being enforced.
 */

import { describe, expect, it } from "vitest";

import { parseEnv } from "../src/config/env.js";

const EXAMPLE_JWT = "dev-only-6c925f080b9865c7f7cc7056555ed86a";
const EXAMPLE_SERVICE = "dev-only-99ccd10ef8fd6991355be151";

/** A configuration that is valid in every respect except the field under test. */
const VALID = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/notifyhub",
  JWT_SECRET: "a-real-secret-long-enough-to-pass",
  SERVICE_KEY: "a-real-service-key",
} as const;

function problemFields(overrides: Record<string, string | undefined>): string[] {
  const result = parseEnv({ ...VALID, ...overrides });

  // Sorted so a failure names both fields whatever order zod reported them in.
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join(".")).sort();
}

describe("example secrets", () => {
  it("rejects the example JWT secret in production", () => {
    // The failure this prevents is silent: the API starts, serves traffic, and
    // signs every session with a string that is in the repository.
    expect(problemFields({ NODE_ENV: "production", JWT_SECRET: EXAMPLE_JWT })).toEqual([
      "JWT_SECRET",
    ]);
  });

  it("rejects the example service key in production", () => {
    // SERVICE_KEY is the other half: it authorises /internal/queue-stats and the
    // alert script, so the same copy-paste mistake exposes queue internals and
    // delivery errors rather than user sessions.
    expect(problemFields({ NODE_ENV: "production", SERVICE_KEY: EXAMPLE_SERVICE })).toEqual([
      "SERVICE_KEY",
    ]);
  });

  it("reports both when the whole example file was copied", () => {
    expect(
      problemFields({
        NODE_ENV: "production",
        JWT_SECRET: EXAMPLE_JWT,
        SERVICE_KEY: EXAMPLE_SERVICE,
      }),
    ).toEqual(["JWT_SECRET", "SERVICE_KEY"]);
  });

  it("accepts real secrets in production", () => {
    expect(problemFields({ NODE_ENV: "production" })).toEqual([]);
  });

  it("allows the example values in development", () => {
    // Refusing them here would break the documented setup path and teach people
    // to ignore the check that matters.
    expect(
      problemFields({
        NODE_ENV: "development",
        JWT_SECRET: EXAMPLE_JWT,
        SERVICE_KEY: EXAMPLE_SERVICE,
      }),
    ).toEqual([]);
  });

  it("allows the example values in test", () => {
    expect(
      problemFields({
        NODE_ENV: "test",
        JWT_SECRET: EXAMPLE_JWT,
        SERVICE_KEY: EXAMPLE_SERVICE,
      }),
    ).toEqual([]);
  });

  it("only matches the exact example value", () => {
    // A near miss is a real generated secret and must not be refused - otherwise
    // this turns into an obstacle during setup.
    expect(
      problemFields({ NODE_ENV: "production", JWT_SECRET: `${EXAMPLE_JWT}-real` }),
    ).toEqual([]);
  });

  it("still enforces the length rules in production", () => {
    // The guard is additive. A secret that is both too short and not the example
    // value must still be rejected for being too short.
    expect(problemFields({ NODE_ENV: "production", JWT_SECRET: "short" })).toEqual([
      "JWT_SECRET",
    ]);
  });

  it("still reports a missing database url", () => {
    expect(problemFields({ NODE_ENV: "production", DATABASE_URL: undefined })).toEqual([
      "DATABASE_URL",
    ]);
  });
});