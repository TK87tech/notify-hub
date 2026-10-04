/**
 * backend/.env.example cannot drift from the schema in src/config/env.ts.
 *
 * The example file is how somebody configures this service, and the schema is
 * what actually reads the environment. When those disagree the failure is
 * confusing in both directions:
 *
 *  - a variable in the schema but not the example file is unset, so it silently
 *    takes its default. For DATABASE_URL that is a crash at boot; for SENTRY_DSN
 *    it is monitoring that quietly never reports anything.
 *  - a variable in the example file but not the schema is ignored entirely, which
 *    reads as "I set it and nothing happened".
 *
 * A checklist item on an issue asks somebody to remember to compare these two
 * files, once. This compares them on every run instead, which is the only version
 * of the check that is still true next quarter.
 *
 * The keys come from a successful `parseEnv` rather than from reading the schema
 * source, so a field added with a default is covered here automatically without
 * this test needing to know how the schema is written.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseEnv } from "../src/config/env.js";

/** Relative to this file rather than the process cwd, so it survives the runner. */
const EXAMPLE_FILE = fileURLToPath(new URL("../.env.example", import.meta.url));

/** Enough to parse: the three fields with no default. NODE_ENV stays unset, which
 *  defaults to development - the production guard is covered in env.test.ts. */
const MINIMAL = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/notifyhub",
  JWT_SECRET: "a-real-secret-long-enough-to-pass",
  SERVICE_KEY: "a-real-service-key",
};

function schemaKeys(): string[] {
  const result = parseEnv({ ...MINIMAL });

  // If this throws, the schema grew a required field and MINIMAL is out of date -
  // which is a real thing to fix here rather than work around.
  if (!result.success) {
    throw new Error(
      `parseEnv rejected the minimal fixture: ${result.error.issues
        .map((issue) => issue.path.join("."))
        .join(", ")}`,
    );
  }

  // zod strips unknown keys, so this is exactly the declared set.
  return Object.keys(result.data).sort();
}

function documentedKeys(): string[] {
  const keys = new Set<string>();

  for (const line of readFileSync(EXAMPLE_FILE, "utf8").split("\n")) {
    // Commented-out assignments count. Several are the only mention of a variable
    // that has no local default, and CORS_ORIGINS is documented that way on
    // purpose because there is no sensible local value for it.
    const match =
      /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim()) ?? /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());

    if (match) keys.add(match[1]);
  }

  // Sorted so a failure lists the same order whatever order the file was edited in.
  return [...keys].sort();
}

describe("backend/.env.example", () => {
  it("documents every variable the schema reads", () => {
    const missing = schemaKeys().filter((key) => !documentedKeys().includes(key));

    expect(missing).toEqual([]);
  });

  it("documents nothing the schema does not read", () => {
    // The other direction. A stale entry sends somebody to configure a variable
    // that no longer exists.
    const stale = documentedKeys().filter((key) => !schemaKeys().includes(key));

    expect(stale).toEqual([]);
  });

  it("keeps the example secrets in step with the guard", () => {
    // The production guard in env.ts refuses one exact JWT_SECRET and one exact
    // SERVICE_KEY. If somebody regenerates the example values here without
    // updating EXAMPLE_SECRETS, the guard silently stops protecting the file it
    // exists to protect - the deployment boots with a published secret again.
    const example = readFileSync(EXAMPLE_FILE, "utf8");

    const jwt = /^JWT_SECRET=(.*)$/m.exec(example)?.[1];
    const service = /^SERVICE_KEY=(.*)$/m.exec(example)?.[1];

    expect(problemFieldsInProduction({ JWT_SECRET: jwt, SERVICE_KEY: service })).toEqual([
      "JWT_SECRET",
      "SERVICE_KEY",
    ]);
  });
});

function problemFieldsInProduction(
  overrides: Record<string, string | undefined>,
): string[] {
  const result = parseEnv({ ...MINIMAL, ...overrides, NODE_ENV: "production" });

  return result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")).sort();
}
