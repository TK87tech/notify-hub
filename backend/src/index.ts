/**
 * Server entry point.
 *
 * Kept separate from app.ts so tests can build an app without binding a port,
 * and so the worker process can import the same libraries without starting an
 * HTTP server.
 */

import { Sentry } from "./lib/sentry.js";
import { createApp } from "./app.js";
import { env, isProduction } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";
import { createRealtimeGateway } from "./realtime/gateway.js";

Sentry.init();

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`NotifyHub API listening on http://localhost:${env.PORT}`);
  logger.info(`  health   GET  http://localhost:${env.PORT}/health`);
  logger.info(`  ready    GET  http://localhost:${env.PORT}/health/ready`);
  logger.info(`  queue    GET  http://localhost:${env.PORT}/api/v1/ops/queue-stats`);
  logger.info(`  env      ${env.NODE_ENV}`);
});

/**
 * Socket.IO attaches here, to the same HTTP server, so there is one port and
 * one CORS configuration. Done before the first request can arrive, which is
 * why it lives here and not inside createApp().
 */
const gateway = createRealtimeGateway(server);

if (isProduction && !env.CORS_ORIGINS.length) {
  logger.warn(
    "CORS_ORIGINS is empty. The frontend is probably on a different domain from APP_URL, so browser calls will fail with a CORS error.",
  );
}

/**
 * Shut down cleanly: stop taking new requests, let in-flight ones finish, then
 * close the socket server, the database pool and Redis.
 *
 * Without this, Render's deploy kills requests mid-flight and Postgres is left
 * holding connections. The order matters: sockets first so no new work starts,
 * then the HTTP server, then the connections everything else was using.
 */
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);

  const forced = setTimeout(() => {
    logger.error("shutdown timed out after 10s, forcing exit");
    process.exit(1);
  }, 10_000);
  forced.unref();

  try {
    await gateway.close();
  } catch (err) {
    logger.error({ err }, "error closing the realtime gateway");
  }

  server.close(async () => {
    try {
      await prisma.$disconnect();
      await closeRedis();
      await Sentry.close(2_000);
      logger.info("closed cleanly");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled promise rejection");
  Sentry.captureException(reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  // An uncaught exception leaves the process in an unknown state. Log it, let
  // Sentry have it, and restart rather than serving traffic we cannot trust.
  logger.fatal({ err }, "uncaught exception");
  Sentry.captureException(err);
  process.exit(1);
});