/**
 * Bell-owned notification routes.
 *
 * The browser reads notifications from /api/v1 and the system producer posts
 * to /internal. Both are implemented here so the backend finally matches the
 * API contract rather than serving only the health check and auth skeleton.
 */

import { Router, type ErrorRequestHandler } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { NotificationType, Priority } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { badRequest, notFound } from "../lib/errors.js";
import { currentUserId } from "../middleware/auth.js";
import { enqueueNotification } from "../lib/queue.js";
import { quietHoursDelayMs } from "../lib/quiet-hours.js";

const notificationTypeSchema = z.enum([
  "task_assigned",
  "payment_received",
  "deadline_warning",
  "comment",
  "system",
]);

const prioritySchema = z.enum(["urgent", "normal", "low"]).default("normal");

const DEFAULT_CHANNEL_SET = {
  inApp: true,
  email: true,
  push: false,
} as const;

const DEFAULT_CHANNELS: Record<
  string,
  { inApp: boolean; email: boolean; push: boolean }
> = {
  task_assigned: { ...DEFAULT_CHANNEL_SET },
  payment_received: { inApp: true, email: true, push: true },
  deadline_warning: { inApp: true, email: false, push: true },
  comment: { inApp: true, email: false, push: false },
  system: { inApp: true, email: true, push: false },
};

function normalizeChannelSet(
  raw: unknown,
  type: string,
): { inApp: boolean; email: boolean; push: boolean } {
  const pref = (raw as Record<string, unknown> | undefined)?.[type] as
    | Record<string, unknown>
    | undefined;

  const base = DEFAULT_CHANNELS[type] ?? DEFAULT_CHANNEL_SET;

  return {
    inApp: Boolean(pref?.inApp ?? base.inApp),
    email: Boolean(pref?.email ?? base.email),
    push: Boolean(pref?.push ?? base.push),
  };
}

function decodeCursor(
  raw?: string,
): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;

  const [createdAtRaw, id] = raw.split("_");

  if (!createdAtRaw || !id) return undefined;

  const createdAt = new Date(createdAtRaw);

  if (Number.isNaN(createdAt.getTime())) return undefined;

  return { createdAt, id };
}

function buildNextCursor(
  items: Array<{ id: string; createdAt: Date }>,
): string | null {
  if (items.length === 0) return null;

  const last = items[items.length - 1];

  return `${last.createdAt.toISOString()}_${last.id}`;
}

function buildNotificationPayload(notification: {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  priority: string;
  read: boolean;
  createdAt: Date;
  data: Prisma.JsonValue;
}) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    priority: notification.priority,
    read: notification.read,
    createdAt: notification.createdAt,
    data: notification.data ?? {},
  };
}

export const notificationApiRouter = Router();

notificationApiRouter.get("/notifications", async (req, res) => {
  const userId = currentUserId(req);

  const limit = z
    .coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .parse(req.query.limit ?? 20);

  const status = z
    .enum(["all", "unread"])
    .default("all")
    .parse(req.query.status ?? "all");

  const cursor = decodeCursor(
    typeof req.query.cursor === "string" ? req.query.cursor : undefined,
  );

  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(status === "unread" ? { read: false } : {}),
    ...(cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            {
              AND: [
                { createdAt: { equals: cursor.createdAt } },
                { id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : {}),
  };

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    prisma.notification.count({
      where: { userId, read: false },
    }),
  ]);

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? buildNextCursor(page) : null;

  res.json({
    items: page.map(buildNotificationPayload),
    unreadCount,
    ...(nextCursor ? { nextCursor } : {}),
  });
});

notificationApiRouter.get("/notifications/unread-count", async (req, res) => {
  const userId = currentUserId(req);

  const unreadCount = await prisma.notification.count({
    where: { userId, read: false },
  });

  res.json({ unreadCount });
});

notificationApiRouter.patch("/notifications/:id/read", async (req, res) => {
  const userId = currentUserId(req);

  const notification = await prisma.notification.findUnique({
    where: { id: req.params.id },
  });

  if (!notification || notification.userId !== userId) {
    throw notFound("Notification not found");
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { read: true, readAt: new Date() },
  });

  const unreadCount = await prisma.notification.count({
    where: { userId, read: false },
  });

  res.json({
    notification: buildNotificationPayload({
      id: updated.id,
      type: updated.type,
      title: updated.title,
      body: updated.body,
      link: updated.link,
      priority: updated.priority,
      read: updated.read,
      createdAt: updated.createdAt,
      data: updated.data,
    }),
    unreadCount,
  });
});

notificationApiRouter.patch("/notifications/read-all", async (req, res) => {
  const userId = currentUserId(req);

  const updated = await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true, readAt: new Date() },
  });

  const unreadCount = await prisma.notification.count({
    where: { userId, read: false },
  });

  res.json({
    updated: updated.count,
    unreadCount,
  });
});

const internalNotificationBodySchema = z.object({
  userId: z.string().min(1),
  type: notificationTypeSchema,
  title: z.string().min(1),
  body: z.string().optional().nullable(),
  link: z.string().optional().nullable(),
  priority: prioritySchema,
  idempotencyKey: z.string().optional(),
  data: z.record(z.string(), z.any()).default({}),
});

export const internalNotificationRouter = Router();

internalNotificationRouter.post("/notifications", async (req, res) => {
  const payload = internalNotificationBodySchema.parse(req.body);

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { preference: true },
  });

  if (!user) {
    throw notFound("User not found");
  }

  const channelSet = normalizeChannelSet(
    user.preference?.channels ?? {},
    payload.type,
  );

  const enabledChannels = Object.entries(channelSet)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  if (enabledChannels.length === 0) {
    res.status(202).json({
      jobId: null,
      status: "suppressed",
    });
    return;
  }

  if (payload.idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key: payload.idempotencyKey },
    });

    if (existing) {
      res.status(202).json({
        jobId: existing.notificationId ?? null,
        status: "duplicate",
      });
      return;
    }
  }

  const notification = await prisma.notification.create({
    data: {
      userId: user.id,
      type: payload.type as NotificationType,
      title: payload.title,
      body: payload.body ?? null,
      link: payload.link ?? null,
      priority: payload.priority as Priority,
      data: payload.data as Prisma.InputJsonValue,
    },
  });

  if (payload.idempotencyKey) {
    await prisma.idempotencyKey.create({
      data: {
        key: payload.idempotencyKey,
        notificationId: notification.id,
      },
    });
  }

  const quietHours =
    user.preference?.quietStart &&
    user.preference?.quietEnd &&
    user.preference?.quietTimezone
      ? {
          start: user.preference.quietStart,
          end: user.preference.quietEnd,
          timezone: user.preference.quietTimezone,
        }
      : null;

  // Only low priority waits out quiet hours (docs/BELL-DECISIONS.md);
  // urgent and normal go straight to the queue.
  const delay =
    payload.priority === "low"
      ? quietHoursDelayMs(quietHours)
      : 0;

  await enqueueNotification(
    {
      notificationId: notification.id,
      userId: user.id,
      priority: payload.priority,
    },
    delay,
  );

  res.status(202).json({
    jobId: notification.id,
    status: delay > 0 ? "delayed" : "queued",
  });
});

const internalNotificationErrorHandler: ErrorRequestHandler = (
  err,
  _req,
  _res,
  next,
) => {
  if (err instanceof z.ZodError) {
    next(badRequest("Invalid notification payload", err.issues));
    return;
  }

  next(err);
};

internalNotificationRouter.use(internalNotificationErrorHandler);