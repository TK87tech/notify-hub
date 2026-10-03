import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, queueMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    notification: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  queueMock: {
    enqueueNotification: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/lib/queue.js", () => ({
  enqueueNotification: queueMock.enqueueNotification,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireUser: (req: any, _res: any, next: any) => {
    req.user = {
      sub: "user-1",
      email: "test@example.com",
    };
    next();
  },
  requireService: (_req: any, _res: any, next: any) => {
    next();
  },
  currentUserId: (req: any) => req.user.sub,
}));

import { createApp } from "../src/app.js";

const app = createApp();

describe("notification API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown user", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post("/internal/notifications")
      .send({
        userId: "missing-user",
        type: "comment",
        title: "Hello",
        priority: "normal",
      });

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe("User not found");
  });

  it("suppresses a notification when every channel is disabled", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          comment: {
            inApp: false,
            email: false,
            push: false,
          },
        },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    });

    const response = await request(app)
      .post("/internal/notifications")
      .send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        priority: "normal",
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("suppressed");
    expect(queueMock.enqueueNotification).not.toHaveBeenCalled();
  });

  it("queues a notification when at least one channel is enabled", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          comment: {
            inApp: true,
            email: false,
            push: false,
          },
        },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    });

    prismaMock.notification.create.mockResolvedValue({
      id: "notification-1",
    });

    queueMock.enqueueNotification.mockResolvedValue({
      id: "job-1",
    });

    const response = await request(app)
      .post("/internal/notifications")
      .send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        priority: "normal",
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("queued");
    expect(response.body.jobId).toBe("notification-1");

    expect(queueMock.enqueueNotification).toHaveBeenCalledWith(
      {
        notificationId: "notification-1",
        userId: "user-1",
        priority: "normal",
      },
      0,
    );
  });

  it("returns duplicate when idempotency key already exists", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          comment: {
            inApp: true,
            email: false,
            push: false,
          },
        },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    });

    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      key: "duplicate-key",
      notificationId: "notification-existing",
    });

    const response = await request(app)
      .post("/internal/notifications")
      .send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        priority: "normal",
        idempotencyKey: "duplicate-key",
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("duplicate");
    expect(response.body.jobId).toBe("notification-existing");

    expect(prismaMock.notification.create).not.toHaveBeenCalled();
    expect(queueMock.enqueueNotification).not.toHaveBeenCalled();
  });

  it("does not allow a user to read another user's notification", async () => {
    prismaMock.notification.findUnique.mockResolvedValue({
      id: "n-other-user",
      userId: "user-456",
      type: "task_assigned",
      title: "Private task",
      body: "This belongs to another user",
      link: "/tasks/99",
      priority: "normal",
      read: false,
      readAt: null,
      data: {},
      createdAt: new Date("2026-09-21T08:14:00.000Z"),
    });

    const response = await request(app)
      .patch("/api/v1/notifications/n-other-user/read")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
    expect(prismaMock.notification.update).not.toHaveBeenCalled();
  });
});