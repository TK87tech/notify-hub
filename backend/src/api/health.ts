/**
 * Two health endpoints, because they answer different questions.
 *
 *   GET /health        Is the process alive? No dependencies touched, so it
 *                      stays fast and Render's health check never fails just
 *                      because Postgres is briefly slow.
 *   GET /health/ready  Can it actually serve traffic? Pings the database and
 *                      Redis. This is the one to look at when something is
 *                      wrong, and the one the deploy gate waits on.
 *
 * Neither requires authentication - a health check that needs a token is no
 * use to the thing checking it. Neither leaks a version, a host name or a
 * connection string.
 */

import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { pingRedis } from "../lib/redis.js";
import { isTest } from "../config/env.js";

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/health/ready", async (_req, res) => {
  const checks: Record<string, "ok" | "failed" | "skipped"> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    logger.error({ err }, "database health check failed");
    checks.database = "failed";
  }

  // Redis is only load-bearing once there is a worker and a gateway. A
  // frontend-only preview deploy has no Redis, and reporting it as not ready
  // would take that deploy down for no reason.
  if (isTest) {
    checks.redis = "skipped";
  } else {
    checks.redis = (await pingRedis()) ? "ok" : "failed";
  }

  // "skipped" does not count against readiness; "failed" does.
  const ready = Object.values(checks).every((value) => value === "ok" || value === "skipped");

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});