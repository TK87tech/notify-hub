/**
 * The queues.
 *
 * Three of them, for reasons that are worth knowing before changing anything:
 *
 *   notifications        in-app and push
 *   notifications.email  email, separate so Brevo's rate limit slows down
 *                        emails only. A rate limiter on the shared queue would
 *                        hold up in-app delivery behind the email budget.
 *   notifications.dlq    the dead-letter queue. Nothing reads it except a human
 *                        and the health endpoint, so a job here is never
 *                        silently discarded.
 *
 * One job is one (notification, channel) pair, not one notification. Channels
 * fail independently - a dead push token must not stop the email going out -
 * so they get their own job, their own retries and their own delivery_attempts
 * rows.
 */

import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { logger } from "./logger.js";
import type { ChannelName } from "../channels/types.js";

export const notificationQueueName = "notifications";
export const emailQueueName = "notifications.email";
export const deadLetterQueueName = "notifications.dlq";

/**
 * BullMQ treats a *lower* number as more urgent.
 *
 * The gaps are deliberate. If a fourth priority level is ever added it can
 * slot in as 3 without renumbering anything, and a job already sitting in Redis
 * keeps the meaning it was queued with.
 */
export const BULLMQ_PRIORITY = {
  urgent: 1,
  normal: 5,
  low: 10,
} as const;

/** How many tries a delivery gets before it is dead-lettered. */
export const MAX_ATTEMPTS = 5;

/** Exponential backoff, starting at two seconds: 2s, 4s, 8s, 16s. */
export const BACKOFF_BASE_MS = 2_000;

export interface NotificationJobData {
  notificationId: string;
  userId: string;
  channel: ChannelName;
  priority: "urgent" | "normal" | "low";
  /** Which try this is, 1-based. Mirrors the job's own attemptsMade + 1. */
  attempt: number;
}

export interface DeadLetterJobData extends NotificationJobData {
  /** Why the job ended up here, already a one-line summary. */
  reason: string;
  /** The provider's error, kept for the runbook. */
  error: string;
  /** True when the channel said this will never work, as opposed to giving up. */
  permanent: boolean;
  /** ISO timestamp of the attempt that gave up. */
  failedAt: string;
}

/**
 * BullMQ refuses a job that has both `priority` and `delay` set - it is a real
 * limitation, not a style preference. So a delayed job (quiet hours, daily email
 * quota) is enqueued without a priority, and a job with a priority is never
 * delayed. Priority already does the work of ordering the queue; the delay
 * only exists when we want a specific later moment.
 */
function jobOptions(data: NotificationJobData, delay: number) {
  return {
    /**
     * The job id is the idempotency key for the queue: BullMQ ignores a second
     * job whose id matches one still waiting, so a producer that retries its own
     * HTTP call cannot queue the same email twice.
     */
    jobId: jobIdFor(data),

    delay,

    /**
     * A priority is set only on jobs that go out now.
     *
     * BullMQ does not reject the combination, but it does not honour it either:
     * priority orders the waiting list, and a job with a delay is promoted
     * straight out of the delayed set on its timestamp. So for a delayed job the
     * number would be stored and quietly ignored. It is left off instead, so
     * nothing reads a priority that does not mean anything.
     */
    ...(delay === 0 ? { priority: BULLMQ_PRIORITY[data.priority] } : {}),

    attempts: MAX_ATTEMPTS,
    backoff: { type: "exponential" as const, delay: BACKOFF_BASE_MS },

    removeOnComplete: { age: 3_600, count: 1_000 },
    /**
     * Failed jobs are kept so a failure can be explained later. Without this
     * a job vanishes on its last attempt and the evidence goes with it.
     */
    removeOnFail: { age: 24 * 3_600, count: 5_000 },
  };
}

/**
 * BullMQ needs `maxRetriesPerRequest: null`. A command that is still waiting
 * on a reconnect is not a failed command, and the default turns a two-second
 * Redis blip into a pile of thrown errors.
 */
export function createBullMqConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

/**
 * Queue handles are created on first use rather than at import time, so
 * importing a module that talks about queues does not open a Redis connection.
 * Tests import the Express app, which imports the routes, without a broker.
 */
interface QueueOptions {
  limiter?: { max: number; duration: number };
}

function lazyQueue(name: string, opts: QueueOptions = {}) {
  let queue: Queue | null = null;

  return (): Queue => {
    if (!queue) {
      queue = new Queue(name, {
        connection: createBullMqConnection(),
        ...(opts.limiter ? { limiter: opts.limiter } : {}),
      });
    }
    return queue;
  };
}

const getNotificationsQueue = lazyQueue(notificationQueueName);
const getEmailQueue = lazyQueue(emailQueueName, {
  limiter: { max: env.EMAIL_RATE_MAX, duration: env.EMAIL_RATE_WINDOW_MS },
});
const getDeadLetterQueue = lazyQueue(deadLetterQueueName);

export const notificationQueue = getNotificationsQueue;
export const emailQueue = getEmailQueue;
export const deadLetterQueue = getDeadLetterQueue;

/**
 * Notifications and email do not share a queue, so this decides which one a
 * given channel belongs to. The worker has the same function - it is exported
 * rather than duplicated so the two can never disagree about where a job is.
 */
export function queueForChannel(channel: ChannelName): Queue<NotificationJobData> {
  return channel === "email" ? emailQueue() : notificationQueue();
}

/**
 * `jobId` overrides the idempotent default. Only a deliberate re-send (a
 * dead-letter requeue) passes one: under the default id BullMQ would silently
 * ignore the add while the original job is still retained as completed/failed.
 */
export async function enqueueNotification(
  data: NotificationJobData,
  delay = 0,
  jobId?: string,
): Promise<string> {
  const options = jobOptions(data, delay);
  const job = await queueForChannel(data.channel).add(
    "deliver-notification",
    data,
    jobId ? { ...options, jobId } : options,
  );

  return job.id ?? jobId ?? jobIdFor(data);
}

/**
 * Parks a job without spending one of its attempts.
 *
 * Used when the reason to wait is not a failure but a policy - the daily email
 * ceiling, a quiet-hours window that was reached later than we expected. The
 * job is removed from its queue and re-added with a delay, so it is not
 * consuming a retry or showing up as failed.
 *
 * Returns the new job id, which is always different from the old one: the id
 * that makes re-enqueueing a no-op is held by the original entry, and BullMQ
 * needs a free id to re-add under. The parking id carries the timestamp, so a
 * job that is parked twice for different reasons gets two distinct entries
 * instead of the second one being swallowed as a duplicate.
 *
 * The attempt counter is carried over explicitly. BullMQ starts a fresh job at
 * attemptsMade 0, so without this a job parked on the fifth try would get
 * another five.
 */
export async function parkJob(
  data: NotificationJobData,
  until: Date,
  reason: string,
): Promise<string> {
  const queue = queueForChannel(data.channel);
  const current = await queue.getJob(jobIdFor(data));

  if (current) {
    await current.remove().catch(() => undefined);
  }

  const parkedId = `${jobIdFor(data)}@${until.getTime()}`;

  const job = await queue.add(
    "deliver-notification",
    data,
    {
      ...jobOptions(data, Math.max(0, until.getTime() - Date.now())),
      jobId: parkedId,
      // Parking is not a retry, so it spends no attempt - but it does not refund
      // the ones already used either. The job keeps what it had left, and
      // processJob counts from data.attempt so it still knows its last try.
      attempts: Math.max(1, MAX_ATTEMPTS - (data.attempt - 1)),
    },
  );

  logger.info(
    {
      notificationId: data.notificationId,
      channel: data.channel,
      attempt: data.attempt,
      until: until.toISOString(),
      reason,
    },
    "parked delivery until the quota window reopens",
  );

  return job.id ?? parkedId;
}

export function jobIdFor(data: Pick<NotificationJobData, "notificationId" | "channel">): string {
  /**
   * The separator is a dash, not a colon, and that is not a style choice.
   *
   * BullMQ reserves ':' to join a repeatable job's name, key and checksum, and
   * Job.validateOptions throws "Custom Id cannot contain :" on any custom id
   * containing a colon. That check lives in the library at runtime, so a colon
   * here fails every enqueue with an error mentioning neither notifications nor
   * BullMQ.
   */
  if (data.notificationId.includes(":")) {
    /**
     * Reachable only if an id arrives from somewhere other than our own `id`
     * column, which is a cuid and cannot contain a colon. Worth the two lines:
     * the alternative is BullMQ's message arriving at the API's error handler
     * minutes later with none of the context needed to place it.
     */
    throw new Error(
      `Notification id cannot contain ":", which BullMQ reserves for custom job ids: ${data.notificationId}`,
    );
  }

  return `${data.notificationId}-${data.channel}`;
}

/**
 * Anything that leaves the queue behind, in either direction. The health
 * endpoint uses this to report queue depth, and the CI smoke test uses it to
 * wait for a job to be picked up.
 */
export function queueEvents(name: string): QueueEvents {
  return new QueueEvents(name, { connection: createBullMqConnection() });
}