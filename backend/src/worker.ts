/**
 * The worker process. `npm run worker`.
 *
 * A separate process from the API on purpose. The API answers HTTP and must stay
 * responsive; delivery talks to third-party providers with timeouts and retries
 * and will occasionally take thirty seconds. Running both in one process means a
 * slow Brevo call is a slow sign-in.
 *
 * This file is wiring only: build a Worker per queue, log, and shut down
 * cleanly. The decisions live in ./worker/process-job.js, which has no
 * top-level side effects and is therefore testable - tests/worker.test.ts drives
 * it directly instead of standing up a broker.
 */

import { Worker } from "bullmq";

import { logger } from "./lib/logger.js";
import { Sentry } from "./lib/sentry.js";
import { prisma } from "./lib/prisma.js";
import {
  createBullMqConnection,
  deadLetterQueueName,
  emailQueueName,
  MAX_ATTEMPTS,
  notificationQueueName,
  type NotificationJobData,
} from "./lib/queue.js";
import { closeRedis } from "./lib/redis.js";
import { processJob } from "./worker/process-job.js";

/**
 * Builds one Worker per queue. Two queues need two workers because BullMQ ties
 * a Worker to exactly one queue, and because the email queue carries the Brevo
 * rate limiter.
 */
function createWorker(queueName: string) {
  const worker = new Worker<NotificationJobData>(queueName, processJob, {
    connection: createBullMqConnection(),

    /**
     * One job at a time by default. Concurrency is where "the same email went
     * out four times" bugs come from, and the queue depth on a demo project is
     * never the bottleneck. Raise it, but not by accident.
     */
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),

    /**
     * If the worker is killed mid-job, the job is still marked active in Redis
     * with a lock that has to expire before it can be retried. Two minutes is
     * the floor; anything shorter risks a second worker picking up a job the
     * first one is still running.
     */
    lockDuration: 120_000,

    // Jobs nobody is waiting on any more should not block the queue forever.
    stalledInterval: 30_000,
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id, channel: job.data.channel }, "job completed");
  });

  worker.on("failed", (job, err) => {
    logger.warn(
      { jobId: job?.id, attempt: job?.attemptsMade, error: err.message },
      "job failed, BullMQ will retry if attempts remain",
    );
  });

  worker.on("error", (err) => {
    logger.error({ err }, "worker error");
  });

  return worker;
}

const workers = [createWorker(notificationQueueName), createWorker(emailQueueName)];

Sentry.init();

logger.info(
  {
    queues: [notificationQueueName, emailQueueName, deadLetterQueueName],
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
    attempts: MAX_ATTEMPTS,
  },
  "notification worker started",
);

/**
 * Graceful shutdown: stop accepting jobs, finish the one in hand, then exit.
 *
 * `worker.close()` waits for the active job. Killing the process instead would
 * abandon a half-sent email - the job would be redelivered when the lock expires
 * and, without the idempotency check in processJob, sent twice.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "worker shutting down, finishing the current job");

  const forced = setTimeout(() => {
    logger.error("shutdown timed out after 30s, exiting anyway");
    process.exit(1);
  }, 30_000);
  forced.unref();

  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await closeRedis();
    await prisma.$disconnect();
    logger.info("worker closed cleanly");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during worker shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled promise rejection in worker");
  process.exit(1);
});