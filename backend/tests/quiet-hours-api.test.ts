import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
  idempotencyFindUnique: vi.fn(),
  idempotencyCreate: vi.fn(),
  enqueueNotification: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
    },
    notification: {
      create: mocks.notificationCreate,
    },
    idempotencyKey: {
      findUnique: mocks.idempotencyFindUnique,
      create: mocks.idempotencyCreate,
    },
  },
}));

vi.mock("../src/lib/queue.js", () => ({
  enqueueNotification: mocks.enqueueNotification,
}));

vi.mock("../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/middleware/auth.js")>(
    "../src/middleware/auth.js",
  );

  return {
    ...actual,
    requireService: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { createApp } from "../src/app.js";

describe("quiet hours notification delivery", () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret";
    process.env.SERVICE_KEY = "test-service-key";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T22:30:00.000Z"));

    mocks.idempotencyFindUnique.mockResolvedValue(null);

    mocks.notificationCreate.mockResolvedValue({
      id: "notification-1",
    });

    mocks.idempotencyCreate.mockResolvedValue({
      id: "idempotency-1",
    });

    mocks.enqueueNotification.mockResolvedValue({
      id: "job-1",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays a low-priority notification during quiet hours", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          task_assigned: {
            inApp: true,
            email: true,
            push: true,
          },
        },
        quietStart: "22:00",
        quietEnd: "07:00",
        quietTimezone: "Africa/Lagos",
      },
    });

    const response = await request(app)
      .post("/internal/notifications")
      .set("x-service-key", "test-service-key")
      .send({
        userId: "user-1",
        type: "task_assigned",
        title: "Task assigned",
        body: "You have a new task",
        priority: "low",
        idempotencyKey: "quiet-low-1",
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("delayed");

    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      {
        notificationId: "notification-1",
        userId: "user-1",
        priority: "low",
      },
      7.5 * 60 * 60 * 1000 + 1000,
    );
  });

  it("sends an urgent notification immediately during quiet hours", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          task_assigned: {
            inApp: true,
            email: true,
            push: true,
          },
        },
        quietStart: "22:00",
        quietEnd: "07:00",
        quietTimezone: "Africa/Lagos",
      },
    });

    const response = await request(app)
      .post("/internal/notifications")
      .set("x-service-key", "test-service-key")
      .send({
        userId: "user-1",
        type: "task_assigned",
        title: "Urgent task",
        body: "This is urgent",
        priority: "urgent",
        idempotencyKey: "quiet-urgent-1",
      });

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("queued");

    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      {
        notificationId: "notification-1",
        userId: "user-1",
        priority: "urgent",
      },
      0,
    );
  });
});