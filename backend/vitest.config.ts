import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * Runs before any test file is imported, so config/env.ts sees a complete
     * environment without every test having to set it up first.
     */
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    singleFork: true,
    fileParallelism: false,
  },
});
