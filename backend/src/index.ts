/**
 * Server entry point.
 *
 * Kept separate from app.ts so tests can build an app without binding a port,
 * and so the worker process can import the same libraries without starting
 * an HTTP server.
 */

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`NotifyHub API listening on http://localhost:${env.PORT}`);
  logger.info(`  health   GET  http://localhost:${env.PORT}/health`);
  logger.info(`  ready    GET  http://localhost:${env.PORT}/health/ready`);
  logger.info(`  env      ${env.NODE_ENV}`);
});

/**
 * Shut down cleanly: stop taking new requests, let in-flight ones finish,
 * then close the database pool. Without this, Render's deploy kills requests
 * mid-flight and Postgres is left holding connections.
 */
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
      logger.info("closed cleanly");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  });

  // If something hangs, do not wait forever.
  setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled promise rejection");
  process.exit(1);
});
