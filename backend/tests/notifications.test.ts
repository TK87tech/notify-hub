/**
 * Bell-owned notification routes.
 *
 * These tests exercise the app without needing a live Postgres database by
 * stubbing the Prisma layer at the module boundary.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const prismaMock = {
  user: {
    findUnique: vi.fn(),
  },
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  idempotencyKey: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const SECRET = "test-secret-at-least-16-chars";
const SERVICE_KEY = "test-service-key";

let app: Express;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = SECRET;
  process.env.SERVICE_KEY = SERVICE_KEY;
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:5173";

  const appModule = await import("../src/app.js");
  app = appModule.createApp();

  const createdNotification = {
    id: "job-123",
    userId: "user-123",
    type: "task_assigned",
    title: "Task assigned",
    body: "Design review",
    link: "/tasks/91",
    priority: "normal",
    read: false,
    data: { taskId: 91 },
    createdAt: new Date("2026-09-21T08:14:00.000Z"),
  };

  prismaMock.user.findUnique.mockResolvedValue({ id: "user-123", preference: { channels: { task_assigned: { inApp: true, email: true, push: false } } } });
  prismaMock.notification.findMany.mockResolvedValue([
    {
      id: "n1",
      userId: "user-123",
      type: "task_assigned",
      title: "Task assigned",
      body: "Design review",
      link: "/tasks/91",
      priority: "normal",
      read: false,
      readAt: null,
      data: { taskId: 91 },
      createdAt: new Date("2026-09-21T08:14:00.000Z"),
    },
  ]);
  prismaMock.notification.count.mockResolvedValue(1);
  prismaMock.notification.create.mockResolvedValue(createdNotification);
  prismaMock.notification.update.mockResolvedValue({
    ...createdNotification,
    read: true,
    readAt: new Date("2026-09-21T08:15:00.000Z"),
  });
  prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
  prismaMock.idempotencyKey.create.mockResolvedValue({ key: "task-91", notificationId: "job-123" });
  prismaMock.notification.updateMany.mockResolvedValue({ count: 1 });
});

describe("Bell notification routes", () => {
  it("lists notifications for the signed-in user", async () => {
    const token = (await import("../src/middleware/auth.js")).signToken({ sub: "user-123", email: "tk@notifyhub.test" });

    const res = await request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.items[0].id).toBe("n1");
  });

  it("marks a notification read and returns a fresh unread count", async () => {
    const token = (await import("../src/middleware/auth.js")).signToken({ sub: "user-123", email: "tk@notifyhub.test" });
    prismaMock.notification.findUnique.mockResolvedValue({
      id: "n1",
      userId: "user-123",
      type: "task_assigned",
      title: "Task assigned",
      body: "Design review",
      link: "/tasks/91",
      priority: "normal",
      read: false,
      readAt: null,
      data: { taskId: 91 },
      createdAt: new Date("2026-09-21T08:14:00.000Z"),
    });
    prismaMock.notification.update.mockResolvedValue({
      id: "n1",
      userId: "user-123",
      type: "task_assigned",
      title: "Task assigned",
      body: "Design review",
      link: "/tasks/91",
      priority: "normal",
      read: true,
      readAt: new Date("2026-09-21T08:15:00.000Z"),
      data: { taskId: 91 },
      createdAt: new Date("2026-09-21T08:14:00.000Z"),
    });

    const res = await request(app).patch("/api/v1/notifications/n1/read").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.notification.read).toBe(true);
    expect(res.body.unreadCount).toBe(1);
  });

  it("accepts a notification request from a trusted service and returns queued", async () => {
    const res = await request(app)
      .post("/internal/notifications")
      .set("x-service-key", SERVICE_KEY)
      .send({
        userId: "user-123",
        type: "task_assigned",
        title: "Ada assigned you a task",
        body: "Design review",
        link: "/tasks/91",
        priority: "normal",
        idempotencyKey: "task-91-assigned-u42",
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    expect(res.body.jobId).toBe("job-123");
  });

  it("returns suppressed when the user has disabled every channel for the type", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-123",
      preference: { channels: { task_assigned: { inApp: false, email: false, push: false } } },
    });

    const res = await request(app)
      .post("/internal/notifications")
      .set("x-service-key", SERVICE_KEY)
      .send({
        userId: "user-123",
        type: "task_assigned",
        title: "Ada assigned you a task",
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("suppressed");
  });
});
