/**
 * How a producer asks for a delivery, without knowing BullMQ exists.
 *
 * Channel code calls `scheduleDelivery` or `deliverNow`. It never touches a
 * Queue, a job, a delay in milliseconds or a priority number. That is the
 * boundary issue #16 asks for: adding a reminder feature must not require
 * anyone to learn how the queue works.
 *
 * The queue details themselves are asserted in tests/queue.test.ts, so if this
 * facade ever starts leaking them the tests fail rather than a reviewer
 * noticing in review.
 */

import { Channel } from "@prisma/client";

import { logger } from "./logger.js";
import { isWithinQuietHours, quietHoursDelayMs, type QuietHours } from "./quiet-hours.js";
import { enqueueNotification, type NotificationJobData } from "./queue.js";

export interface DeliveryRequest {
  notificationId: string;
  userId: string;
  channels: Channel[];
  priority: "urgent" | "normal" | "low";
}

/**
 * What actually happened. The producer returns a subset of this, because the
 * contract's 202 only carries jobId and status.
 */
export interface DeliveryOutcome {
  /** One entry per channel we tried to schedule. */
  jobs: Array<{ channel: Channel; jobId: string; scheduledFor: Date }>;
  /** True when quiet hours pushed the delivery later. */
  delayed: boolean;
}

export interface ScheduleOptions {
  /** Explicit delivery time, used by reminders and deadline warnings. */
  deliverAt?: Date;
  /** The user's quiet hours, already read off their preference row. */
  quietHours?: QuietHours | null;
  now?: Date;
}

/**
 * When should this actually go out?
 *
 * Two things can hold a notification back, and they have to be combined
 * correctly rather than whichever happened to be checked first:
 *
 *   - Quiet hours. Only `low` priority waits (docs/BELL-DECISIONS.md). Urgent
 *     goes through whatever the user asked for, and normal is not delayed - it
 *     is the default, and delaying it by a whole night surprises people.
 *   - An explicit deliverAt from a reminder. It always wins: a reminder for
 *     09:00 tomorrow must not be pulled back to 07:00 by a quiet-hours rule.
 */
export function resolveDeliveryTime(
  priority: "urgent" | "normal" | "low",
  options: ScheduleOptions = {},
): Date {
  const now = options.now ?? new Date();

  if (options.deliverAt) {
    return options.deliverAt;
  }

  if (priority !== "low" || !isWithinQuietHours(options.quietHours ?? null, now)) {
    return now;
  }

  return new Date(now.getTime() + quietHoursDelayMs(options.quietHours ?? null, now));
}

/**
 * Schedules one job per channel.
 *
 * Per channel rather than per notification, because a channel that fails must
 * not stop the others. An email Brevo rejects should not stop the in-app
 * notification, and a dead push token should not stop the email.
 */
export async function scheduleDelivery(
  request: DeliveryRequest,
  options: ScheduleOptions = {},
): Promise<DeliveryOutcome> {
  const now = options.now ?? new Date();

  /**
   * Both timestamps are taken once, here. Computing "when should this go" and
   * "how long to wait" from two separate calls to new Date() costs a few
   * milliseconds of drift, which shows up as a delay that never quite matches
   * the requested time and makes the maths in the tests unreadable.
   */
  const scheduledFor = resolveDeliveryTime(request.priority, { ...options, now });
  const delay = Math.max(0, scheduledFor.getTime() - now.getTime());

  const jobs: DeliveryOutcome["jobs"] = [];

  for (const channel of request.channels) {
    const data: NotificationJobData = {
      notificationId: request.notificationId,
      userId: request.userId,
      channel,
      priority: request.priority,
      attempt: 1,
    };

    const jobId = await enqueueNotification(data, delay);

    jobs.push({ channel, jobId, scheduledFor });
  }

  logger.info(
    {
      notificationId: request.notificationId,
      userId: request.userId,
      channels: request.channels,
      scheduledFor: scheduledFor.toISOString(),
      delayedByMs: delay,
    },
    "scheduled delivery",
  );

  return { jobs, delayed: delay > 0 };
}

/**
 * The common case: queue it as soon as the user's preferences allow.
 *
 * Deliberately identical to scheduleDelivery with no deliverAt - it exists so
 * the producer reads as prose ("deliver now") rather than as a function call
 * with an empty options object. Quiet hours still apply; only an explicit
 * deliverAt bypasses them.
 */
export function deliverNow(
  request: DeliveryRequest,
  options: ScheduleOptions = {},
): Promise<DeliveryOutcome> {
  return scheduleDelivery(request, options);
}