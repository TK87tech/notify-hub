import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Vite's define replaces import.meta.env at build time. Without this, any
    // test that reads a public env var sees undefined instead of the .env value,
    // which is how "works on my machine" bugs get into a passing suite.
    env: {
      // Mirrors the contract's `servers[0].url`, which includes the /api/v1
      // prefix. Testing against a differently shaped base URL than production
      // would hide exactly the path-concatenation bug this guards against.
      VITE_API_URL: "http://api.test/api/v1",
    },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});