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
        deleteMany: vi.fn(),
      },
      notification: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
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

    queueMock.enqueueNotification.mockResolvedValue("notification-1-in_app");

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

    // One job per enabled channel, not one job for the notification. A channel
    // that fails must not stop the others, so they retry independently.
    expect(queueMock.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(queueMock.enqueueNotification).toHaveBeenCalledWith(
      {
        notificationId: "notification-1",
        userId: "user-1",
        channel: "in_app",
        priority: "normal",
        attempt: 1,
      },
      0,
    );
  });

  it("queues a separate job for each enabled channel", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: {
          payment_received: { inApp: true, email: true, push: true },
        },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    });

    prismaMock.notification.create.mockResolvedValue({ id: "notification-9" });
    queueMock.enqueueNotification.mockResolvedValue("job");

    await request(app).post("/internal/notifications").send({
      userId: "user-1",
      type: "payment_received",
      title: "Payment received",
    });

    const channels = queueMock.enqueueNotification.mock.calls.map(
      ([data]) => (data as { channel: string }).channel,
    );

    expect(channels.sort()).toEqual(["email", "in_app", "push"]);
  });

  it("schedules a reminder for the time given by deliverAt", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: "user-1",
      preference: {
        channels: { task_assigned: { inApp: true, email: false, push: false } },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    });

    prismaMock.notification.create.mockResolvedValue({ id: "notification-8" });
    queueMock.enqueueNotification.mockResolvedValue("job");

    const deliverAt = "2099-10-04T09:00:00.000Z";

    const before = Date.now();

    const response = await request(app).post("/internal/notifications").send({
      userId: "user-1",
      type: "task_assigned",
      title: "Standup",
      priority: "low",
      deliverAt,
    });

    const expected = new Date(deliverAt).getTime() - before;

    expect(response.status).toBe(202);
    expect(response.body.status).toBe("delayed");

    const [data, delay] = queueMock.enqueueNotification.mock.calls[0];

    expect(data).toMatchObject({ notificationId: "notification-8", channel: "in_app" });
    // Within a couple of milliseconds: the queue computes the delay from its
    // own clock a moment after the handler took ours.
    expect(delay).toBeGreaterThan(expected - 50);
    expect(delay).toBeLessThanOrEqual(expected);
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

  it("rolls back the notification and key when queueing fails, so a retry is not a duplicate", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: "user-1", preference: null });
    prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
    prismaMock.notification.create.mockResolvedValue({ id: "n-new" });
    prismaMock.idempotencyKey.create.mockResolvedValue({});
    prismaMock.notification.delete.mockResolvedValue({});
    prismaMock.idempotencyKey.deleteMany.mockResolvedValue({ count: 1 });
    queueMock.enqueueNotification.mockRejectedValue(new Error("redis down"));

    const response = await request(app)
      .post("/internal/notifications")
      .send({ userId: "user-1", type: "comment", title: "Hello", idempotencyKey: "k-1" });

    expect(response.status).toBe(500);
    expect(prismaMock.notification.delete).toHaveBeenCalledWith({ where: { id: "n-new" } });
    expect(prismaMock.idempotencyKey.deleteMany).toHaveBeenCalledWith({ where: { key: "k-1" } });
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

  describe("concurrent producers with the same idempotency key", () => {
    const user = {
      id: "user-1",
      preference: {
        channels: { comment: { inApp: true, email: false, push: false } },
        quietStart: null,
        quietEnd: null,
        quietTimezone: null,
      },
    };

    /**
     * The unique constraint on idempotencyKey.key is the only thing standing
     * between two simultaneous requests and two copies of the same message. The
     * loser finds out here, and what it does next is the whole test.
     */
    beforeEach(() => {
      prismaMock.user.findUnique.mockResolvedValue(user);
      prismaMock.notification.create.mockResolvedValue({ id: "notification-loser" });
      prismaMock.notification.delete.mockResolvedValue({});
      queueMock.enqueueNotification.mockResolvedValue("job");

      // The pre-check sees nothing, so both requests proceed to the insert.
      prismaMock.idempotencyKey.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ key: "race-key", notificationId: "notification-winner" });

      // Prisma's unique-constraint violation.
      prismaMock.idempotencyKey.create.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
    });

    it("answers with the winner's notification id, not the one it deleted", async () => {
      const response = await request(app).post("/internal/notifications").send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        idempotencyKey: "race-key",
      });

      expect(response.status).toBe(202);
      expect(response.body.status).toBe("duplicate");

      // Returning the loser's own id here would hand the caller a jobId for a
      // row that was just deleted, so every follow-up on it would 404 while the
      // caller believed it was tracking a live delivery.
      expect(response.body.jobId).toBe("notification-winner");
      expect(response.body.jobId).not.toBe("notification-loser");
    });

    it("deletes its own notification and queues nothing for it", async () => {
      await request(app).post("/internal/notifications").send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        idempotencyKey: "race-key",
      });

      // An orphan row would show up in the user's inbox as a phantom
      // notification that never arrived by any channel.
      expect(prismaMock.notification.delete).toHaveBeenCalledWith({
        where: { id: "notification-loser" },
      });

      // And the loser must not queue a second copy of the message.
      expect(queueMock.enqueueNotification).not.toHaveBeenCalled();
    });

    it("still reports the duplicate when it cannot re-read the winner", async () => {
      // The re-read is a second query and can fail on its own. Reporting a null
      // jobId still tells the producer "do not send this again", which is the
      // decision that matters; a 500 would make it retry forever.
      prismaMock.idempotencyKey.findUnique
        .mockReset()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const response = await request(app).post("/internal/notifications").send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        idempotencyKey: "race-key",
      });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ jobId: null, status: "duplicate" });
    });
  });

  describe("a database failure that is not a duplicate", () => {
    beforeEach(() => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: "user-1",
        preference: {
          channels: { comment: { inApp: true, email: false, push: false } },
          quietStart: null,
          quietEnd: null,
          quietTimezone: null,
        },
      });

      prismaMock.notification.create.mockResolvedValue({ id: "notification-1" });
    });

    it("propagates instead of deleting the notification and calling it a duplicate", async () => {
      prismaMock.idempotencyKey.findUnique.mockResolvedValue(null);
      prismaMock.idempotencyKey.create.mockRejectedValue(
        Object.assign(new Error("connection terminated"), { code: "P1001" }),
      );

      const response = await request(app).post("/internal/notifications").send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        idempotencyKey: "race-key",
      });

      /**
       * The dangerous version of this handler catches every error from the
       * insert. Then an unreachable database deletes a notification that was
       * never delivered, answers 202 "duplicate", and the producer - seeing a
       * success - never retries. The message is simply gone, with no error
       * anywhere.
       */
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe("internal");

      expect(prismaMock.notification.delete).not.toHaveBeenCalled();
      expect(queueMock.enqueueNotification).not.toHaveBeenCalled();
    });

    it("treats a key that cannot be checked at all as a server error, not a pass", async () => {
      prismaMock.idempotencyKey.findUnique.mockRejectedValue(
        Object.assign(new Error("timeout"), { code: "P1008" }),
      );

      const response = await request(app).post("/internal/notifications").send({
        userId: "user-1",
        type: "comment",
        title: "Hello",
        idempotencyKey: "race-key",
      });

      // Silently ignoring the check would queue duplicates for as long as the
      // database is unwell.
      expect(response.status).toBe(500);
      expect(prismaMock.notification.create).not.toHaveBeenCalled();
    });
  });
});
