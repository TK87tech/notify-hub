/**
 * Redis connections, created lazily and shared.
 *
 * Three different things need Redis, and they must not share one client:
 *
 *   - BullMQ needs `maxRetriesPerRequest: null`, because a queued command that
 *     is still waiting on a reconnect is not a failure.
 *   - A subscriber connection goes into subscriber mode the moment it
 *     subscribes and cannot issue ordinary commands afterwards.
 *   - A publisher can use any normal client.
 *
 * All of them are created on first use rather than at import time, so importing
 * a module that happens to use Redis does not open a socket. Tests import the
 * Express app without a Redis server running.
 */

import { Redis } from "ioredis";
import { env, isTest } from "../config/env.js";
import { logger } from "./logger.js";

let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let probeClient: Redis | null = null;

/** A plain client for publishing. BullMQ-style options, safe to share. */
export function publisher(): Redis {
  if (!publisherClient) {
    publisherClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    publisherClient.on("error", (err) => logger.error({ err }, "redis publisher error"));
  }

  return publisherClient;
}

/**
 * A third client, used only to answer "is Redis up?".
 *
 * This exists because the other two cannot answer that question. Both use
 * maxRetriesPerRequest: null, which tells ioredis to queue a command and wait
 * for a reconnect rather than ever failing it. That is exactly right for a job
 * that should survive a blip, and exactly wrong for a health check: pingRedis
 * would wait on a PING that never returns, so /health/ready would hang instead
 * of reporting 503 and the alert would never fire. Both of those are needed most
 * during the outage the check exists to report.
 *
 * enableOfflineQueue: false is the setting that matters. A command issued while
 * disconnected fails immediately instead of joining the reconnect queue. The
 * timeout race below is belt and braces, because a health check that can hang is
 * worse than no health check at all.
 */
function probe(): Redis {
  if (!probeClient) {
    probeClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      lazyConnect: true,
    });

    // Reconnects are expected and would otherwise log on every probe.
    probeClient.on("error", () => {});
  }

  return probeClient;
}

/** A hard ceiling, so a wedged socket cannot hold the readiness check open. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Raised when a Redis command outlives its deadline.
 *
 * The reason this exists: the clients built above use maxRetriesPerRequest: null,
 * which tells ioredis to queue a command and wait for a reconnect rather than
 * ever failing it. That is right for a delivery job that should survive a blip
 * and badly wrong for anything on a health or stats path, because there the
 * failure mode is a silent hang rather than an error. A readiness check that
 * never returns is worse than no readiness check - the deploy gate waits on it,
 * and an alert whose only job is to speak up cannot hang quietly.
 *
 * Any caller that wants to know whether Redis is there, rather than ride
 * through an outage, should go through this.
 */
export class RedisTimeoutError extends Error {
  constructor(ms: number) {
    super(`redis command did not settle within ${ms}ms`);
    this.name = "RedisTimeoutError";
  }
}

/**
 * Races a command against a deadline. The command itself is not cancelled -
 * ioredis has no clean per-command abort - but the caller stops waiting, which
 * is the part that matters.
 */
export function bounded<T>(work: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new RedisTimeoutError(ms)), ms).unref?.();
    }),
  ]);
}

/**
 * A dedicated subscriber. ioredis puts a connection into subscriber mode on the
 * first `subscribe`, so it can never be reused for anything else.
 */
export function subscriber(): Redis {
  if (!subscriberClient) {
    subscriberClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });

    subscriberClient.on("error", (err) => logger.error({ err }, "redis subscriber error"));
  }

  return subscriberClient;
}

/**
 * True when we can actually reach Redis. Used by the readiness check and by
 * code that would rather degrade than crash when Redis is down.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const client = probe();
    if (client.status === "wait") await bounded(client.connect());

    return (await bounded(client.ping())) === "PONG";
  } catch {
    return false;
  }
}

/**
 * Tests never talk to Redis. Publishing becomes a no-op so route tests can
 * exercise the code path without a broker.
 */
export const redisAvailable = !isTest;

export async function closeRedis(): Promise<void> {
  const clients = [publisherClient, subscriberClient, probeClient].filter(Boolean) as Redis[];

  publisherClient = null;
  subscriberClient = null;
  probeClient = null;

  await Promise.all(
    clients.map((client) =>
      client.quit().catch(() => client.disconnect()),
    ),
  );
}