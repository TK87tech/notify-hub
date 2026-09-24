/**
 * Two health endpoints, because they answer different questions.
 *
 *   GET /health        Is the process alive? No dependencies touched, so it
 *                      stays fast and Render's health check never fails just
 *                      because Postgres is briefly slow.
 *
 *   GET /health/ready  Can it actually serve traffic? Pings the database.
 *                      This is the one to look at when something is wrong.
 *
 * Neither requires authentication - a health check that needs a token is no
 * use to the thing checking it.
 */

import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

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
  const checks: Record<string, "ok" | "failed"> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    logger.error({ err }, "database health check failed");
    checks.database = "failed";
  }

  const ready = Object.values(checks).every((v) => v === "ok");
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});
