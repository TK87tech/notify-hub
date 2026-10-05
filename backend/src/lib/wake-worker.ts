/**
 * Wakes the worker when there is work for it.
 *
 * On Render's free tier the worker runs as a web service, and a web service
 * that receives no HTTP traffic for 15 minutes is put to sleep. A sleeping
 * worker takes nothing off the queue - the jobs wait in Redis until something
 * wakes it. So whenever the API queues a job it also knocks on the worker's
 * /health. The API is awake at that moment by definition: it is answering the
 * request that produced the job.
 *
 * Fire-and-forget, and at most once a minute: the knock only has to land
 * once to wake the service, and delivery must never wait on it or fail
 * because of it. Unset WORKER_WAKE_URL (local, tests, a worker that never
 * sleeps) makes this a no-op.
 */

import { env } from "../config/env.js";
import { logger } from "./logger.js";

const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 5_000;

let lastKnock: number | null = null;

export function wakeWorker(now = Date.now()): void {
  if (!env.WORKER_WAKE_URL) return;
  if (lastKnock !== null && now - lastKnock < MIN_INTERVAL_MS) return;

  lastKnock = now;

  // A cold start takes ~30s, longer than the timeout. That is fine: Render
  // starts waking the service on the first byte of the request, so the
  // abort only stops us waiting for an answer we do not need.
  fetch(env.WORKER_WAKE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err: unknown) => {
    logger.debug({ err }, "worker wake-up request did not complete (expected during a cold start)");
  });
}

/** Tests only: forget the last knock so the throttle starts fresh. */
export function resetWakeThrottleForTests(): void {
  lastKnock = null;
}
