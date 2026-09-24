import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One process, so the env vars the tests set are not fought over.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
