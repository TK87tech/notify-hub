/**
 * One Prisma client for the whole process.
 *
 * Creating a client per request opens a new connection pool each time and
 * exhausts Postgres in minutes. Import this, never `new PrismaClient()`.
 *
 * The globalThis dance keeps a single instance across hot reloads in dev -
 * without it, tsx watch leaks a pool on every file save.
 */

import { PrismaClient } from "@prisma/client";
import { env, isProduction } from "../config/env.js";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
