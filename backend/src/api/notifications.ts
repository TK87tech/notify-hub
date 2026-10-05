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
import { Channel as PrismaChannel, NotificationType, Priority } from "@prisma/client";

import { prisma } from "../lib/prisma.js";
import { badRequest, isUniqueViolation, notFound } from "../lib/errors.js";
import { currentUserId } from "../middleware/auth.js";
import { deliverNow } from "../lib/delivery.js";
import type { QuietHours } from "../lib/quiet-hours.js";
import { publishToUser } from "../realtime/publisher.js";
import { REALTIME_EVENTS } from "../realtime/events.js";

const notificationTypeSchema = z.enum([
  "task_assigned",
  "payment_received",
  "deadline_warning",
  "comment",
  "system",
]);

const prioritySchema = z.enum(["urgent", "normal", "low"]).default("normal");

/**
 * The defaults, straight from docs/BELL-DECISIONS.md. Kept here and in the
 * seed script because they are the contract's promise to a user who has never
 * opened the settings page.
 */
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

/** Which Prisma channel each contract key maps to. */
const CHANNEL_BY_KEY = {
  inApp: PrismaChannel.in_app,
  email: PrismaChannel.email,
  push: PrismaChannel.push,
} as const;

type ChannelKey = keyof typeof CHANNEL_BY_KEY;

/**
 * Merges the saved preferences over the defaults, one key at a time.
 *
 * Deliberately forgiving: a preference row saved before a notification type
 * existed simply has no entry for it, and that must fall back to the default
 * rather than silently disabling a channel the user never turned off.
 */
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

function enabledChannels(
  raw: unknown,
  type: string,
): PrismaChannel[] {
  const set = normalizeChannelSet(raw, type);

  return (Object.keys(CHANNEL_BY_KEY) as ChannelKey[])
    .filter((key) => set[key])
    .map((key) => CHANNEL_BY_KEY[key]);
}

function quietHoursOf(preference: {
  quietStart: string | null;
  quietEnd: string | null;
  quietTimezone: string | null;
} | null): QuietHours | null {
  if (!preference?.quietStart || !preference.quietEnd || !preference.quietTimezone) {
    return null;
  }

  return {
    start: preference.quietStart,
    end: preference.quietEnd,
    timezone: preference.quietTimezone,
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

async function unreadCountFor(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, read: false } });
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

  /**
   * Issue #25 asks for a filter by type as well as by read state. The contract
   * does not have it yet, so it is accepted as an optional query parameter and
   * simply ignored when absent - the contract gains the parameter in the same
   * pull request that the frontend starts sending it.
   */
  const type =
    typeof req.query.type === "string"
      ? notificationTypeSchema.safeParse(req.query.type)
      : null;

  const cursor = decodeCursor(
    typeof req.query.cursor === "string" ? req.query.cursor : undefined,
  );

  const where: Prisma.NotificationWhereInput = {
    userId,
    ...(status === "unread" ? { read: false } : {}),
    ...(type?.success ? { type: type.data as NotificationType } : {}),
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

  res.json({ unreadCount: await unreadCountFor(userId) });
});

notificationApiRouter.patch("/notifications/:id/read", async (req, res) => {
  const userId = currentUserId(req);

  const notification = await prisma.notification.findUnique({
    where: { id: req.params.id },
  });

  // Same 404 for "does not exist" and "belongs to somebody else". A different
  // status would confirm that somebody else's notification id is real.
  if (!notification || notification.userId !== userId) {
    throw notFound("Notification not found");
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { read: true, readAt: new Date() },
  });

  const unreadCount = await unreadCountFor(userId);

  // Keeps every other tab and the phone in agreement. The REST call is the one
  // code path; the socket just tells the others what happened.
  publishToUser(userId, REALTIME_EVENTS.notificationRead, {
    id: updated.id,
    unreadCount,
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

  const unreadCount = await unreadCountFor(userId);

  publishToUser(userId, REALTIME_EVENTS.notificationReadAll, { unreadCount });

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
  /** Reminder-style scheduling: when this should actually go out. */
  deliverAt: z.string().datetime().optional(),
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

  const channels = enabledChannels(user.preference?.channels ?? {}, payload.type);

  if (channels.length === 0) {
    res.status(202).json({ jobId: null, status: "suppressed" });
    return;
  }

  /**
   * Idempotency is checked before the insert, and the insert of the key itself
   * is what makes it safe against two producers racing: the key's primary key
   * rejects the second one, which is caught below and answered as a duplicate
   * rather than a 409.
   */
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
    try {
      await prisma.idempotencyKey.create({
        data: {
          key: payload.idempotencyKey,
          notificationId: notification.id,
        },
      });
    } catch (err) {
      /**
       * Only P2002 means somebody else got here first. Anything else - the
       * connection dropping, the table missing - has to propagate: swallowing it
       * would delete a notification that was never delivered and answer
       * "duplicate", so the producer would never retry and the message would
       * simply vanish.
       */
      if (!isUniqueViolation(err)) throw err;

      // The winner's notification is the one that exists and will be delivered,
      // so retire ours rather than leaving an orphan row behind.
      await prisma.notification.delete({ where: { id: notification.id } }).catch(() => undefined);

      // The winner's id, not ours. Ours is the row just deleted, so handing it
      // back would leave the caller holding a jobId that resolves to nothing.
      const winner = await prisma.idempotencyKey.findUnique({
        where: { key: payload.idempotencyKey },
        select: { notificationId: true },
      });

      res.status(202).json({ jobId: winner?.notificationId ?? null, status: "duplicate" });
      return;
    }
  }

  const deliverAt = payload.deliverAt ? new Date(payload.deliverAt) : undefined;

  let outcome;

  try {
    outcome = await deliverNow(
      {
        notificationId: notification.id,
        userId: user.id,
        channels,
        priority: payload.priority,
      },
      {
        ...(deliverAt ? { deliverAt } : {}),
        quietHours: quietHoursOf(user.preference),
      },
    );
  } catch (err) {
    // Queueing failed (Redis down). Undo the insert and the key, so the
    // producer's retry is a fresh attempt instead of a "duplicate" of a
    // notification that was never queued. Any channel job that did get queued
    // finds no row and dead-letters harmlessly.
    await prisma.notification.delete({ where: { id: notification.id } }).catch(() => undefined);
    if (payload.idempotencyKey) {
      await prisma.idempotencyKey
        .deleteMany({ where: { key: payload.idempotencyKey } })
        .catch(() => undefined);
    }
    throw err;
  }

  res.status(202).json({
    jobId: notification.id,
    status: deliverAt || outcome.delayed ? "delayed" : "queued",
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