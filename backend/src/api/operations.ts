/**
 * The operator view (issue #33).
 *
 * Queue depth, how long a delivery takes, the failure rate and the size of the
 * dead-letter queue. One builder, three mounts, because the same numbers are
 * wanted by three different callers:
 *
 *   GET /internal/queue-stats   service key  - the alert job and the runbook
 *   GET /api/v1/ops/queue-stats JWT          - the queue health page
 *
 * The user-facing route is deliberately not restricted to a staff role. This
 * is a portfolio project on a free tier with one shared team account, and the
 * value of the view comes from being openable without a second login. It
 * exposes no user data - only counts, durations and error strings - so the
 * worst case is that somebody learns how busy the queue is.
 */

import { Router } from "express";
import type { Queue } from "bullmq";

import { prisma } from "../lib/prisma.js";
import { currentUserId } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import { emailUsageToday, endOfUtcDay } from "../lib/email-quota.js";
import { pingRedis } from "../lib/redis.js";
import {
  deadLetterQueue,
  deadLetterQueueName,
  emailQueue,
  emailQueueName,
  notificationQueue,
  notificationQueueName,
} from "../lib/queue.js";
import { env } from "../config/env.js";

/** Below this, `degraded`. At or above, `failing`. See docs/RUNBOOK.md. */
const DLQ_WARN_THRESHOLD = Number(process.env.DLQ_WARN_THRESHOLD ?? 10);
const DLQ_FAIL_THRESHOLD = Number(process.env.DLQ_FAIL_THRESHOLD ?? 50);

interface QueueSnapshot {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  /**
   * A boolean, not a count: BullMQ's getJobCounts has no paused state in this
   * version, and a made-up number here would be worse than none. A paused queue
   * is the single most useful thing to know when notifications stop arriving.
   */
  paused: boolean;
}

/**
 * Counts in one round trip per queue. `getJobCounts` is a single Redis call,
 * which matters when this endpoint is what an alert polls every five minutes.
 */
async function snapshot(name: string, queue: Queue): Promise<QueueSnapshot> {
  const [counts, paused] = await Promise.all([
    queue.getJobCounts("waiting", "active", "delayed", "completed", "failed"),
    queue.isPaused(),
  ]);

  return {
    name,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    paused,
  };
}

/**
 * Delivery performance over a rolling window, straight from delivery_attempts.
 *
 * The average is computed in SQL rather than by loading rows, so the endpoint
 * stays fast as the table grows.
 */
async function deliveryStats(since: Date) {
  const [totals, recent] = await Promise.all([
    prisma.deliveryAttempt.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.deliveryAttempt.groupBy({
      by: ["channel", "status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const byStatus = Object.fromEntries(
    totals.map((row) => [row.status, row._count._all]),
  ) as Partial<Record<string, number>>;

  const sent = byStatus.sent ?? 0;
  const failed = byStatus.failed ?? 0;
  const dead = byStatus.dead ?? 0;

  const byChannel: Record<string, { sent: number; failed: number; dead: number }> = {};

  for (const row of recent) {
    const entry = (byChannel[row.channel] ??= { sent: 0, failed: 0, dead: 0 });
    entry[row.status as "sent" | "failed" | "dead"] = row._count._all;
  }

  return {
    windowHours: Math.round((Date.now() - since.getTime()) / 3_600_000),
    sent,
    failed,
    dead,
    // Dead letters are not counted as failures here on purpose: a dead letter
    // is the system correctly giving up on something, and counting it twice
    // makes the failure rate look worse than it is.
    failureRate: sent + failed === 0 ? 0 : Number((failed / (sent + failed)).toFixed(4)),
    byChannel,
  };
}

/**
 * End-to-end processing time: producer row created, provider accepted it.
 *
 * Two design notes, both of which came out of trying to do this the obvious way.
 *
 * The obvious way is BullMQ's processedOn minus timestamp. That measures how
 * long the worker held the job, which is a different question, and completed
 * jobs are trimmed after an hour, so it could only ever describe the last hour.
 *
 * A mean is worse than useless here. A notification that needed three attempts
 * waited out two backoffs, so the mean is dragged up by exactly the deliveries
 * that were already visible as failures elsewhere in this payload. Reporting
 * p50 and p95 keeps the healthy path and the tail separable.
 *
 * This is the one raw query in the file. The latency lives in the gap between
 * two tables' columns, which no Prisma aggregate can express, and percentiles
 * have no aggregate equivalent. Postgres-only, which the deploy already is.
 */
async function processingTime(since: Date) {
  const [row] = await prisma.$queryRaw<
    { p50: number | null; p95: number | null; samples: number }[]
  >`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::float  AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::float AS p95,
      count(*)::int AS samples
    FROM (
      SELECT EXTRACT(EPOCH FROM (a."createdAt" - n."createdAt")) * 1000 AS ms
      FROM "delivery_attempts" a
      JOIN "notifications" n ON n."id" = a."notificationId"
      WHERE a."status" = 'sent'::"DeliveryStatus"
        AND a."createdAt" >= ${since}
    ) AS samples
  `;

  return {
    p50Ms: row?.p50 === null || row?.p50 === undefined ? null : Math.round(row.p50),
    p95Ms: row?.p95 === null || row?.p95 === undefined ? null : Math.round(row.p95),
    samples: row?.samples ?? 0,
  };
}

/** What a queue looks like when we could not ask it. */
function unreachableSnapshot(name: string): QueueSnapshot {
  return {
    name,
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 0,
    failed: 0,
    paused: false,
  };
}

export async function buildQueueStats() {
  const since = new Date(Date.now() - 24 * 3_600_000);

  const redisUp = await pingRedis();

  // When Redis is down, stop. The BullMQ clients use maxRetriesPerRequest: null
  // so a queued job survives a blip, which also means getJobCounts waits on a
  // reconnect instead of returning - so asking the queues here would hang until
  // the client is torn down. This endpoint is what reports the outage, so it is
  // the last place that can afford to be the thing that hangs.
  //
  // Zeroed counts are honest here in a way they usually are not: nothing is
  // known, and redis.reachable: false is what the caller has to read.
  if (!redisUp) {
    return {
      status: "failing" as const,
      checkedAt: new Date().toISOString(),
      redis: { reachable: false },
      depth: { total: 0, waiting: 0, active: 0, delayed: 0 },
      queues: {
        notifications: unreachableSnapshot(notificationQueueName),
        email: unreachableSnapshot(emailQueueName),
      },
      deadLetter: {
        size: 0,
        warnThreshold: DLQ_WARN_THRESHOLD,
        failThreshold: DLQ_FAIL_THRESHOLD,
      },
      deliveries: {
        windowHours: 24,
        sent: 0,
        failed: 0,
        dead: 0,
        failureRate: 0,
        byChannel: {},
      },
      processing: { p50Ms: null, p95Ms: null, samples: 0 },
      emailQuota: {
        used: await emailUsageToday().catch(() => 0),
        limit: env.EMAIL_DAILY_LIMIT,
        resetsAtUtc: endOfUtcDay().toISOString(),
      },
    };
  }

  const [notifications, email, dlq, deliveries, processing, emailUsed] =
    await Promise.all([
      snapshot(notificationQueueName, notificationQueue()),
      snapshot(emailQueueName, emailQueue()),
      snapshot(deadLetterQueueName, deadLetterQueue()),
      deliveryStats(since),
      processingTime(since),
      emailUsageToday(),
    ]);

  const depth = notifications.waiting + notifications.delayed + email.waiting + email.delayed;
  const failureRate = deliveries.failureRate;

  let status: "ok" | "degraded" | "failing" = "ok";

  if (!redisUp) {
    status = "failing";
  } else if (dlq.failed >= DLQ_FAIL_THRESHOLD || failureRate > 0.25) {
    status = "failing";
  } else if (dlq.failed >= DLQ_WARN_THRESHOLD || failureRate > 0.1 || depth > 500) {
    status = "degraded";
  }

  return {
    status,
    checkedAt: new Date().toISOString(),
    redis: { reachable: redisUp },
    depth: {
      /** Everything waiting to be picked up, including delayed jobs. */
      total: depth,
      waiting: notifications.waiting + email.waiting,
      active: notifications.active + email.active,
      delayed: notifications.delayed + email.delayed,
    },
    queues: { notifications, email },
    deadLetter: {
      size: dlq.failed,
      warnThreshold: DLQ_WARN_THRESHOLD,
      failThreshold: DLQ_FAIL_THRESHOLD,
    },
deliveries,
    processing,
emailQuota: {
      used: emailUsed,
      limit: env.EMAIL_DAILY_LIMIT,
      resetsAtUtc: endOfUtcDay().toISOString(),
    },
  };
}

/** Everything the dead-letter queue currently holds, newest first. */
async function deadLetterEntries(limit: number) {
  const jobs = await deadLetterQueue().getJobs(
    ["waiting", "active", "delayed", "failed", "completed"],
    0,
    limit - 1,
  );

  return jobs.reverse().map((job) => {
    const data = job.data as {
      notificationId?: string;
      userId?: string;
      channel?: string;
      reason?: string;
      error?: string;
      permanent?: boolean;
      failedAt?: string;
    };

    return {
      id: job.id,
      queuedAt: new Date(job.timestamp).toISOString(),
      notificationId: data.notificationId ?? null,
      userId: data.userId ?? null,
      channel: data.channel ?? null,
      reason: data.reason ?? null,
      error: data.error ?? null,
      permanent: data.permanent ?? false,
      failedAt: data.failedAt ?? null,
    };
  });
}

export const operationsServiceRouter = Router();

operationsServiceRouter.get("/queue-stats", async (_req, res) => {
  res.json(await buildQueueStats());
});

operationsServiceRouter.get("/dead-letters", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);

  res.json({ items: await deadLetterEntries(limit) });
});

/** Re-queues a dead-lettered delivery. The manual half of the runbook. */
operationsServiceRouter.post("/dead-letters/requeue", async (req, res) => {
  const id = String(req.query.id ?? "");
  const queue = deadLetterQueue();
  const job = await queue.getJob(id);

  if (!job) {
    res.status(404).json({ error: { code: "not_found", message: "No such dead-letter job" } });
    return;
  }

  const data = job.data as {
    notificationId: string;
    userId: string;
    channel: string;
    priority: "urgent" | "normal" | "low";
    attempt: number;
  };

  const channel = data.channel as "in_app" | "email" | "push";
  const { enqueueNotification } = await import("../lib/queue.js");

  await enqueueNotification(
    {
      notificationId: data.notificationId,
      userId: data.userId,
      channel,
      priority: data.priority,
      attempt: data.attempt,
    },
    0,
  );

  await job.remove();

  logger.info({ deadLetterId: id, notificationId: data.notificationId }, "requeued from dead letter");

  res.json({ status: "requeued", notificationId: data.notificationId, channel });
});

export const operationsRouter = Router();

/**
 * Signed-in view. Adds "your unread count" because that is the one number a
 * user of the health page can act on, and adds nothing that identifies anyone.
 */
operationsRouter.get("/ops/queue-stats", async (req, res) => {
  const userId = currentUserId(req);

  const [stats, unread] = await Promise.all([
    buildQueueStats(),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);

  res.json({ ...stats, you: { unreadCount: unread } });
});