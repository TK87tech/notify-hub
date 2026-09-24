/**
 * Seed data for local development.
 *
 * Creates two users with notifications across all five types, a mix of read
 * and unread, plus preferences and a device. Pulse and Beacon can point the
 * frontend at a real backend and see a realistic list straight away.
 *
 * Run:  npm run db:seed
 * Safe to run repeatedly - it clears its own data first.
 */

import { PrismaClient, NotificationType, Priority, Channel, DeliveryStatus, DevicePlatform } from "@prisma/client";

const prisma = new PrismaClient();

/** The default every user starts with, until they change it. */
const DEFAULT_CHANNELS = {
  task_assigned: { inApp: true, email: true, push: false },
  payment_received: { inApp: true, email: true, push: true },
  deadline_warning: { inApp: true, email: false, push: true },
  comment: { inApp: true, email: false, push: false },
  system: { inApp: true, email: true, push: false },
};

/** minutesAgo(90) -> a Date 90 minutes before now. */
function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

async function main() {
  console.log("Seeding...");

  // Users cascade, so deleting them clears notifications, preferences and
  // devices too. Idempotency keys have no user, so clear them separately.
  await prisma.idempotencyKey.deleteMany();
  await prisma.user.deleteMany();

  const tk = await prisma.user.create({
    data: {
      email: "tk@notifyhub.test",
      name: "TK",
      preference: {
        create: {
          channels: DEFAULT_CHANNELS,
          quietStart: "22:00",
          quietEnd: "07:00",
          quietTimezone: "Asia/Bangkok",
        },
      },
      devices: {
        create: {
          token: "seed-web-token-tk",
          platform: DevicePlatform.web,
        },
      },
    },
  });

  const ada = await prisma.user.create({
    data: {
      email: "ada@notifyhub.test",
      name: "Ada",
      preference: { create: { channels: DEFAULT_CHANNELS } },
    },
  });

  // Newest first in this list, so the seeded inbox reads naturally.
  const notifications = [
    {
      type: NotificationType.task_assigned,
      title: "Ada assigned you a task",
      body: "Design review",
      link: "/tasks/91",
      priority: Priority.normal,
      read: false,
      createdAt: minutesAgo(2),
      data: { taskId: 91, assignedBy: "ada" },
    },
    {
      type: NotificationType.payment_received,
      title: "Payment received",
      body: "Invoice #204 has been paid",
      link: "/invoices/204",
      priority: Priority.normal,
      read: false,
      createdAt: minutesAgo(60),
      data: { invoiceId: 204, amount: 45000, currency: "NGN" },
    },
    {
      type: NotificationType.deadline_warning,
      title: "Deadline tomorrow",
      body: "Sprint 4 report is due at 17:00",
      link: "/reports/sprint-4",
      priority: Priority.urgent,
      read: false,
      createdAt: minutesAgo(180),
      data: { dueAt: "2026-09-25T17:00:00+07:00" },
    },
    {
      type: NotificationType.comment,
      title: "Chidi commented on your post",
      body: "Have you tried the retry backoff yet?",
      link: "/posts/12#c-88",
      priority: Priority.low,
      read: true,
      readAt: minutesAgo(1200),
      createdAt: minutesAgo(1440),
      data: { postId: 12, commentId: 88 },
    },
    {
      type: NotificationType.system,
      title: "Scheduled maintenance on Sunday",
      body: "The service will be unavailable from 02:00 to 03:00",
      link: null,
      priority: Priority.low,
      read: true,
      readAt: minutesAgo(2800),
      createdAt: minutesAgo(2880),
      data: {},
    },
  ];

  for (const n of notifications) {
    const created = await prisma.notification.create({
      data: { ...n, userId: tk.id },
    });

    // A delivery attempt per channel the preferences allow, so Warden has
    // something to chart and Relay has a shape to write against.
    await prisma.deliveryAttempt.create({
      data: {
        notificationId: created.id,
        channel: Channel.in_app,
        status: DeliveryStatus.sent,
        attempt: 1,
      },
    });
  }

  // One deliberately failed email, so the dead-letter path is visible in the
  // data from day one rather than only after something breaks.
  const failing = await prisma.notification.create({
    data: {
      userId: ada.id,
      type: NotificationType.payment_received,
      title: "Payment received",
      body: "Invoice #205 has been paid",
      link: "/invoices/205",
      priority: Priority.normal,
      read: false,
      createdAt: minutesAgo(30),
      data: { invoiceId: 205 },
    },
  });

  await prisma.deliveryAttempt.createMany({
    data: [
      { notificationId: failing.id, channel: Channel.in_app, status: DeliveryStatus.sent, attempt: 1 },
      { notificationId: failing.id, channel: Channel.email, status: DeliveryStatus.failed, attempt: 1, error: "550 mailbox unavailable" },
      { notificationId: failing.id, channel: Channel.email, status: DeliveryStatus.failed, attempt: 2, error: "550 mailbox unavailable" },
      { notificationId: failing.id, channel: Channel.email, status: DeliveryStatus.dead, attempt: 3, error: "550 mailbox unavailable" },
    ],
  });

  const unread = await prisma.notification.count({ where: { userId: tk.id, read: false } });

  console.log(`  users:          2  (${tk.email}, ${ada.email})`);
  console.log(`  notifications:  ${notifications.length + 1}`);
  console.log(`  unread for TK:  ${unread}`);
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
