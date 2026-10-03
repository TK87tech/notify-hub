/**
 * Staying inside Brevo's free tier.
 *
 * Two separate limits, because they solve different problems:
 *
 *   1. A short-window rate limit, so a burst of a thousand emails does not
 *      arrive in one second. BullMQ's `limiter` handles this on the email
 *      worker, because it delays a job rather than failing it.
 *
 *   2. A hard daily ceiling of 300 on the free plan, counted in Redis. This
 *      one cannot be a limiter: a limiter would push the excess into tomorrow
 *      by milliseconds, not by hours, and Brevo counts the calendar day.
 *
 * When the daily ceiling is reached the caller is told to come back after the
 * UTC day rolls over. The worker parks the job rather than failing it, because
 * a parked email is still worth sending; a dead-lettered one never will be.
 */

import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { bounded, publisher, redisAvailable } from "./redis.js";

const KEY_PREFIX = "notifyhub:quota:email";

/** Thrown when today's ceiling is used up. Carries when to try again. */
export class DailyQuotaExceededError extends Error {
  readonly retryAt: Date;
  readonly limit: number;

  constructor(limit: number, retryAt: Date) {
    super(`Daily email limit of ${limit} reached. Next attempt after ${retryAt.toISOString()}`);
    this.name = "DailyQuotaExceededError";
    this.limit = limit;
    this.retryAt = retryAt;
  }
}

function keyForNow(now: Date): string {
  return `${KEY_PREFIX}:${now.toISOString().slice(0, 10)}`;
}

/** Next UTC midnight, which is when the counter we just read expires anyway. */
export function endOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
}

async function incrementToday(now = new Date()): Promise<number> {
  const client = publisher();

  if (client.status === "wait") await client.connect();

  // Two keys so one key cannot grow without bound, and expiry is automatic:
  // no cleanup job needed, which is one less thing to forget.
  const key = keyForNow(now);
  const ttlMs = endOfUtcDay(now).getTime() - now.getTime();

  const pipeline = client.multi().incr(key).expire(key, Math.ceil(ttlMs / 1000));
  const results = await pipeline.exec();

  return Number(results?.[0]?.[1] ?? 0);
}

/**
 * Claims one email slot for today, or throws DailyQuotaExceededError.
 *
 * Counts optimistically: the slot is consumed even if the provider call then
 * fails. That is deliberate. An email that we attempted but Brevo rejected has
 * still cost us a request, and a limit we can overshoot by retrying is not a
 * limit.
 */
export async function claimEmailSlot(now = new Date()): Promise<void> {
  // Tests and local runs with no Redis get the real behaviour for free: the
  // counter lives in Redis, so with Redis down we stop pretending we have a
  // budget to police. The provider's own 429 is the backstop.
  if (!redisAvailable) return;

  const used = await incrementToday(now);

  if (used > env.EMAIL_DAILY_LIMIT) {
    logger.warn({ used, limit: env.EMAIL_DAILY_LIMIT }, "email daily limit reached");
    throw new DailyQuotaExceededError(env.EMAIL_DAILY_LIMIT, endOfUtcDay(now));
  }
}

/** How many emails have been claimed today. Used by the queue health view. */
export async function emailUsageToday(now = new Date()): Promise<number> {
  if (!redisAvailable) return 0;

  try {
    const client = publisher();

    if (client.status === "wait") await bounded(client.connect());

    // Bounded on purpose. The publisher is built for jobs that should wait out
    // a blip, so during an outage this GET sits in the reconnect queue instead
    // of failing - and a catch cannot catch a hang. This function is read by the
    // health view, so a Redis outage would otherwise wedge the one endpoint
    // meant to report it.
    const value = await bounded(client.get(keyForNow(now)));

    return value ? Number(value) : 0;
  } catch (err) {
    logger.warn({ err }, "could not read email quota usage");
    return 0;
  }
}