/**
 * What one delivery job actually does.
 *
 * Extracted from worker.ts so it can be tested without a Redis connection. The
 * side-effectful parts - constructing Workers, listening for SIGTERM - stay in
 * worker.ts; the decisions stay here, where they are the only interesting part
 * and where they can be exercised directly.
 *
 *   1. Load the notification and the recipient. Anything missing is permanent.
 *   2. Check whether this (notification, channel) has already been delivered. If
 *      so, stop. That is the idempotency guarantee, and it is what stops a
 *      worker killed mid-send from sending the email twice.
 *   3. Ask the channel registry to deliver.
 *   4. Record the attempt in delivery_attempts, always.
 *   5. On a retryable failure, let BullMQ retry with exponential backoff. On the
 *      last attempt, or on a permanent failure, move it to the dead-letter queue
 *      so it is still there to look at tomorrow.
 *
 * Steps 4 and 5 are the difference between a system that works and one you can
 * debug at 3am.
 */

import type { Channel as PrismaChannel } from "@prisma/client";
import { DeliveryStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sendOnChannel } from "../channels/registry.js";
import { DailyQuotaExceededError } from "../lib/email-quota.js";
import { logger } from "../lib/logger.js";
import { Sentry } from "../lib/sentry.js";
import { prisma } from "../lib/prisma.js";
import {
  deadLetterQueue,
  jobIdFor,
  MAX_ATTEMPTS,
  parkJob,
  type DeadLetterJobData,
  type NotificationJobData,
} from "../lib/queue.js";

/**
 * The part of a BullMQ Job this function uses.
 *
 * Declared rather than importing BullMQ's Job so a test can hand in a plain
 * object. BullMQ's own Job satisfies it structurally.
 */
export interface ProcessableJob {
  id?: string;
  attemptsMade: number;
  data: NotificationJobData;
}

/** Thrown to make BullMQ retry without writing a misleading "dead" status. */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeliveryError";
  }
}

async function loadRecipient(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
}

async function alreadyDelivered(
  notificationId: string,
  channel: PrismaChannel,
): Promise<boolean> {
  const sent = await prisma.deliveryAttempt.findFirst({
    where: { notificationId, channel, status: DeliveryStatus.sent },
    select: { id: true },
  });

  return sent !== null;
}

async function recordAttempt(
  notificationId: string,
  channel: PrismaChannel,
  status: DeliveryStatus,
  attempt: number,
  detail: { error?: string; providerRef?: string } = {},
): Promise<void> {
  await prisma.deliveryAttempt.create({
    data: {
      notificationId,
      channel,
      status,
      attempt,
      ...(detail.error ? { error: detail.error.slice(0, 500) } : {}),
      ...(detail.providerRef ? { providerRef: detail.providerRef } : {}),
    },
  });
}

/**
 * Moves a job to the dead-letter queue.
 *
 * The job is re-added rather than moved, because BullMQ cannot move a job
 * between queues atomically and a half-done move loses the notification. If
 * this throws, the original failed job is still in `failed` and still
 * inspectable, which is the outcome we want.
 */
export async function deadLetter(
  data: NotificationJobData,
  reason: string,
  error: string,
  permanent: boolean,
): Promise<void> {
  const payload: DeadLetterJobData = {
    ...data,
    reason,
    error: error.slice(0, 500),
    permanent,
    failedAt: new Date().toISOString(),
  };

  /**
   * The id has to be unique every time, because the dead-letter queue is never
   * drained automatically and BullMQ silently drops an add whose id is taken.
   * `Date.now()` is not enough: two failures in the same millisecond collide, and
   * under a provider outage that is exactly the case that happens. A uuid costs
   * nothing at this rate and cannot collide.
   *
   * The prefix carries the notification and channel so the queue stays legible
   * in `redis-cli`, and uses jobIdFor's dash separator plus an @ — BullMQ
   * reserves ':' for a repeatable job's name, key and checksum and rejects
   * custom ids containing it. A three-part colon id happens to slip past that
   * check today, which is exactly the kind of accident worth not relying on.
   */
  await deadLetterQueue().add("dead-notification", payload, {
    jobId: `${jobIdFor(data)}@${randomUUID()}`,
    removeOnComplete: false,
    removeOnFail: false,
  });

  logger.error(
    { notificationId: data.notificationId, channel: data.channel, reason, error, permanent },
    "delivery dead-lettered",
  );

  Sentry.captureMessage(`delivery dead-lettered: ${reason}`, {
    level: permanent ? "error" : "warning",
    extra: { notificationId: data.notificationId, channel: data.channel, error, permanent },
  });
}

export async function processJob(job: ProcessableJob): Promise<{ status: string }> {
  const { notificationId, userId, channel, priority } = job.data;
  const attempt = job.attemptsMade + 1;
  const isLastAttempt = attempt >= MAX_ATTEMPTS;

  logger.info(
    { jobId: job.id, notificationId, channel, attempt, of: MAX_ATTEMPTS },
    "processing delivery job",
  );

  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    await deadLetter(
      { ...job.data, attempt },
      "notification row is missing",
      `No notification with id ${notificationId}`,
      true,
    );
    throw new PermanentDeliveryError(`Notification ${notificationId} no longer exists`);
  }

  // A job whose userId disagrees with the notification is a bug upstream. Fail
  // permanently rather than deliver somebody else's notification.
  if (notification.userId !== userId) {
    await deadLetter(
      { ...job.data, attempt },
      "user mismatch",
      `Job names user ${userId}, notification belongs to ${notification.userId}`,
      true,
    );
    throw new PermanentDeliveryError("Job user does not own this notification");
  }

  const recipient = await loadRecipient(userId);

  if (!recipient) {
    await deadLetter(
      { ...job.data, attempt },
      "recipient no longer exists",
      `No user with id ${userId}`,
      true,
    );
    throw new PermanentDeliveryError(`User ${userId} no longer exists`);
  }

  // Idempotency. A job that already succeeded on this channel stops here, so a
  // duplicated job, a redelivery after a worker crash, or a producer retry all
  // produce exactly one notification.
  if (await alreadyDelivered(notificationId, channel)) {
    logger.info({ notificationId, channel }, "already delivered on this channel, skipping");
    return { status: "already-delivered" };
  }

  let result;

  try {
    result = await sendOnChannel(channel, {
      notification: {
        id: notification.id,
        userId: notification.userId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        link: notification.link,
        priority: notification.priority,
        data: (notification.data ?? {}) as Record<string, unknown>,
        createdAt: notification.createdAt,
      },
      recipient,
      attempt,
      attemptCount: MAX_ATTEMPTS,
    });
  } catch (err) {
    // A thrown error from a channel is reserved for "do not spend an attempt on
    // this" - today that is only the daily email ceiling.
    if (err instanceof DailyQuotaExceededError) {
      await recordAttempt(notificationId, channel, DeliveryStatus.queued, attempt, {
        error: err.message,
      });

      await parkJob({ ...job.data, attempt }, err.retryAt, "email daily limit reached");

      // Return normally: the job was re-added under a new id, so succeeding here
      // is what stops BullMQ also counting it as a failure.
      return { status: "parked-until-quota-resets" };
    }

    logger.error({ err, notificationId, channel, attempt }, "channel threw unexpectedly");
    await recordAttempt(notificationId, channel, DeliveryStatus.failed, attempt, {
      error: err instanceof Error ? err.message : String(err),
    });

    if (isLastAttempt) {
      await deadLetter(
        { ...job.data, attempt },
        "unexpected error",
        err instanceof Error ? err.message : String(err),
        false,
      );
    }

    throw err;
  }

  if (result.ok) {
    await recordAttempt(notificationId, channel, DeliveryStatus.sent, attempt, {
      providerRef: result.providerRef,
      // A skipped delivery is recorded as sent, because from the system's point
      // of view the channel did its job. The reason goes in `error`, which is
      // the only free-text column on the row.
      ...(result.skipped ? { error: result.detail } : {}),
    });

    logger.info(
      { notificationId, channel, attempt, skipped: result.skipped, priority },
      "delivery succeeded",
    );

    return { status: result.skipped ? "skipped" : "sent" };
  }

  // A failure. Retryable and attempts left: let BullMQ back off and try again.
  if (result.retryable && !isLastAttempt) {
    await recordAttempt(notificationId, channel, DeliveryStatus.failed, attempt, {
      error: result.error,
      providerRef: result.providerRef,
    });

    logger.warn(
      { notificationId, channel, attempt, error: result.error },
      "delivery failed, will retry",
    );

    throw new Error(result.error);
  }

  // Permanent, or out of attempts. Either way it stops and it stays visible.
  await recordAttempt(notificationId, channel, DeliveryStatus.dead, attempt, {
    error: result.error,
    providerRef: result.providerRef,
  });

  await deadLetter(
    { ...job.data, attempt },
    result.retryable ? "retries exhausted" : "permanent failure",
    result.error,
    !result.retryable,
  );

  // Returning normally rather than throwing: BullMQ would otherwise schedule
  // pointless retries for a failure that cannot succeed. The evidence is the
  // dead-letter entry and the delivery_attempts row, not the job's status.
  return { status: result.retryable ? "dead-lettered" : "rejected" };
}