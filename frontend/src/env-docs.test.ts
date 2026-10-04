/**
 * Every VITE_ variable the frontend reads must be in frontend/.env.example.
 *
 * Vite only exposes variables it finds at build time, and only when they are
 * prefixed. A name the code reads but the example file never mentions is
 * undefined at runtime, and because every read here has a fallback the app still
 * starts - so the visible result is not a crash but a setting that quietly does
 * nothing.
 *
 * That is the whole argument for checking this in CI: `import.meta.env` is a
 * stringly-typed lookup with no compile-time error, and the failure mode is
 * "my URL override was ignored" rather than anything that looks like a bug.
 *
 * Walks src/ rather than keeping a hand-written list, so a new VITE_ variable is
 * covered the moment it is written.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the process cwd rather than `import.meta.url`, because this runs
// in jsdom, where `import.meta.url` is an http URL and not a path. Vitest's root
// is frontend/, which is also the folder Vite loads .env from - the same reason.
const SRC_DIR = resolve(process.cwd(), "src");
const EXAMPLE_FILE = resolve(process.cwd(), ".env.example");

/** Skipped by name below. */
const SELF = "env-docs.test.ts";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Vite's own built-ins. Never documented in .env.example, and not ours to set. */
const BUILT_IN = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);

function sourceFiles(dir: string = SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) return [];

    return [path];
  });
}

/**
 * Every `import.meta.env.NAME` the source reads.
 *
 * Skips this file: it necessarily contains the literal string it searches for,
 * and the occurrences in its own regex would otherwise be attributed to itself.
 */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();

  for (const file of sourceFiles()) {
    if (file.endsWith(SELF)) continue;

    for (const match of readFileSync(file, "utf8").matchAll(
      /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    )) {
      const key = match[1];

      if (!BUILT_IN.has(key)) keys.add(key);
    }
  }

  return keys;
}

function documentedKeys(): string[] {
  const keys = new Set<string>();

  for (const line of readFileSync(EXAMPLE_FILE, "utf8").split("\n")) {
    // Optional values are documented as commented-out assignments, so those count
    // as documented. An undocumented optional variable is still a trap.
    const match =
      /^#\s*(VITE_[A-Z0-9_]*)=/.exec(line.trim()) ?? /^(VITE_[A-Z0-9_]*)=/.exec(line.trim());

    if (match) keys.add(match[1]);
  }

  return [...keys].sort();
}

describe("frontend/.env.example", () => {
  it("is found where Vite looks for it", () => {
    // A .env.example in the repository root documents variables Vite will never
    // load, because Vite reads .env from the folder it is run in.
    expect(EXAMPLE_FILE.replace(/\\/g, "/")).toContain("/frontend/.env.example");
  });

  it("documents every VITE_ variable the source reads", () => {
    const documented = documentedKeys();
    const missing = [...referencedKeys()].filter((key) => !documented.includes(key)).sort();

    expect(missing).toEqual([]);
  });

  it("documents no VITE_ variable the source has dropped", () => {
    const referenced = referencedKeys();
    const stale = documentedKeys().filter((key) => !referenced.has(key));

    expect(stale).toEqual([]);
  });
});
