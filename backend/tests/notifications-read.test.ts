/**
 * Bell read routes: list and mark-read for the signed-in user.
 *
 * Prisma and the queue are stubbed at the module boundary, so no live
 * Postgres or Redis is needed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const prismaMock = vi.hoisted(() => ({
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/queue.js", () => ({ enqueueNotification: vi.fn() }));

const unreadNotification = {
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
};

let app: Express;
let token: string;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-secret-at-least-16-chars";
  process.env.SERVICE_KEY = "test-service-key";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:5173";

  app = (await import("../src/app.js")).createApp();
  token = (await import("../src/middleware/auth.js")).signToken({
    sub: "user-123",
    email: "tk@notifyhub.test",
  });

  prismaMock.notification.findMany.mockResolvedValue([unreadNotification]);
  prismaMock.notification.count.mockResolvedValue(1);
});

describe("Bell notification read routes", () => {
  it("lists notifications for the signed-in user", async () => {
    const res = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.items[0].id).toBe("n1");
  });

  it("marks a notification read and returns a fresh unread count", async () => {
    prismaMock.notification.findUnique.mockResolvedValue(unreadNotification);
    prismaMock.notification.update.mockResolvedValue({
      ...unreadNotification,
      read: true,
      readAt: new Date("2026-09-21T08:15:00.000Z"),
    });

    const res = await request(app)
      .patch("/api/v1/notifications/n1/read")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.notification.read).toBe(true);
    expect(res.body.unreadCount).toBe(1);
  });
});
