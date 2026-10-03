/**
 * The in-app channel.
 *
 * There is no provider behind this one. "Delivering" an in-app notification
 * means the row is in Postgres and the browser is told about it, so this
 * channel does two things: confirms the row is there, and publishes the
 * realtime event.
 *
 * The row itself is written by the producer, not here, so that POST
 * /internal/notifications can return an id the caller can use immediately and
 * so a user opening the page before the worker runs still sees their
 * notification. This channel does not create it - a missing row means the data
 * is gone, which is worth a permanent failure rather than a silent no-op.
 */

import { prisma } from "../../lib/prisma.js";
import { publishToUser } from "../../realtime/publisher.js";
import {
  failure,
  success,
  type Channel,
  type ChannelContext,
} from "../types.js";

export const inAppChannel: Channel = {
  name: "in_app",

  async send(ctx: ChannelContext) {
    const { notification, recipient } = ctx;

    const stored = await prisma.notification.findUnique({
      where: { id: notification.id },
      select: { id: true, userId: true, read: true, createdAt: true },
    });

    if (!stored || stored.userId !== recipient.id) {
      return failure(
        `Notification ${notification.id} is missing from the database`,
        false,
      );
    }

    // The room is per user, so a notification that belongs to somebody else
    // must never be broadcast, whatever the job payload claims.
    if (stored.userId !== notification.userId) {
      return failure(
        `Job for notification ${notification.id} names user ${notification.userId} but it belongs to ${stored.userId}`,
        false,
      );
    }

    await publishToUser(recipient.id, "notification:new", {
      notification: {
        id: stored.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        link: notification.link,
        priority: notification.priority,
        read: stored.read,
        createdAt: stored.createdAt.toISOString(),
        data: notification.data ?? {},
      },
      unreadCount: await prisma.notification.count({
        where: { userId: recipient.id, read: false },
      }),
    });

    return success({ detail: "published to user room" });
  },
};