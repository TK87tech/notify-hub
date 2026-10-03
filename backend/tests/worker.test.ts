/**
 * The worker's delivery decisions.
 *
 * BullMQ itself is not involved - processJob takes a plain object - so these
 * tests are about our policy, not the broker's:
 *
 *   - which failures are retried and which give up immediately
 *   - that every attempt is recorded, because that table is the only evidence
 *   - that the dead-letter queue gets the reason, not just the fact
 *   - that a job which already succeeded never sends again
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  sendOnChannel: vi.fn(),
  parkJob: vi.fn(),
  deadLetterAdd: vi.fn(),
  db: {
    notification: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    deliveryAttempt: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.db }));

vi.mock("../src/channels/registry.js", () => ({ sendOnChannel: mocks.sendOnChannel }));

vi.mock("../src/lib/queue.js", () => ({
  MAX_ATTEMPTS: 5,
  jobIdFor: (d: { notificationId: string; channel: string }) => `${d.notificationId}-${d.channel}`,
  parkJob: mocks.parkJob,
  deadLetterQueue: () => ({ add: mocks.deadLetterAdd }),
}));

import { processJob } from "../src/worker/process-job.js";
import { DailyQuotaExceededError } from "../src/lib/email-quota.js";
import type { NotificationJobData } from "../src/lib/queue.js";

const MAX_ATTEMPTS = 5;

const data: NotificationJobData = {
  notificationId: "n1",
  userId: "user-1",
  channel: "email",
  priority: "normal",
  attempt: 1,
};

const storedNotification = {
  id: "n1",
  userId: "user-1",
  type: "task_assigned",
  title: "Task assigned",
  body: "You have a new task",
  link: null,
  priority: "normal",
  data: {},
  createdAt: new Date("2026-09-30T12:00:00.000Z"),
};

/** A job on its given 1-based try. BullMQ reports attemptsMade, which is 0-based. */
function jobOnAttempt(attempt: number, overrides: Partial<NotificationJobData> = {}) {
  return { id: "n1-email", attemptsMade: attempt - 1, data: { ...data, ...overrides } };
}

const recorded = () =>
  mocks.db.deliveryAttempt.create.mock.calls.map(([arg]) => arg.data as Record<string, unknown>);

const deadLettered = () =>
  mocks.deadLetterAdd.mock.calls.map(([, payload]) => payload as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();

  mocks.db.notification.findUnique.mockResolvedValue(storedNotification);
  mocks.db.user.findUnique.mockResolvedValue({ id: "user-1", email: "tk@notifyhub.test", name: "TK" });
  mocks.db.deliveryAttempt.findFirst.mockResolvedValue(null);
  mocks.db.deliveryAttempt.create.mockResolvedValue({});
  mocks.deadLetterAdd.mockResolvedValue({ id: "dlq-1" });
  mocks.parkJob.mockResolvedValue("parked-1");
  mocks.sendOnChannel.mockResolvedValue({ ok: true });
});

describe("the happy path", () => {
  it("records a sent attempt and returns sent", async () => {
    const result = await processJob(jobOnAttempt(1));

    expect(result.status).toBe("sent");
    expect(recorded()).toEqual([
      { notificationId: "n1", channel: "email", status: DeliveryStatus.sent, attempt: 1 },
    ]);
  });

  it("gives the channel the stored notification, not the job's copy", async () => {
    await processJob(jobOnAttempt(1));

    // The database is the source of truth. A job payload edited after it was
    // queued must not change what gets delivered.
    const [, ctx] = mocks.sendOnChannel.mock.calls[0];

    expect(ctx.notification).toMatchObject({ id: "n1", title: "Task assigned" });
    expect(ctx.recipient).toMatchObject({ id: "user-1", email: "tk@notifyhub.test" });
    expect(ctx.attempt).toBe(1);
    expect(ctx.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it("records a skipped delivery as sent, with the reason kept", async () => {
    // "No devices registered" is the channel doing its job. Recording it as
    // failed would put healthy users in the dead-letter queue.
    mocks.sendOnChannel.mockResolvedValue({ ok: true, skipped: true, detail: "user has no registered devices" });

    const result = await processJob(jobOnAttempt(1));

    expect(result.status).toBe("skipped");
    expect(recorded()[0]).toMatchObject({
      status: DeliveryStatus.sent,
      error: "user has no registered devices",
    });
  });
});

describe("idempotency", () => {
  it("does not send again on a channel that already succeeded", async () => {
    mocks.db.deliveryAttempt.findFirst.mockResolvedValue({ id: "attempt-1" });

    const result = await processJob(jobOnAttempt(3));

    // This is what stops a worker killed mid-send from sending the email twice.
    expect(result.status).toBe("already-delivered");
    expect(mocks.sendOnChannel).not.toHaveBeenCalled();
  });

  it("does not record an attempt for a job it declined to run", async () => {
    mocks.db.deliveryAttempt.findFirst.mockResolvedValue({ id: "attempt-1" });

    await processJob(jobOnAttempt(2));

    // Otherwise the count of attempts says we tried three times when we tried once.
    expect(mocks.db.deliveryAttempt.create).not.toHaveBeenCalled();
  });

  it("checks the channel it was asked for, not the notification as a whole", async () => {
    mocks.db.deliveryAttempt.findFirst.mockResolvedValue({ id: "attempt-1" });

    await processJob(jobOnAttempt(1));

    // The email may have gone out while the push failed. One channel's success
    // must not mark the others as delivered.
    expect(mocks.db.deliveryAttempt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { notificationId: "n1", channel: "email", status: DeliveryStatus.sent },
      }),
    );
  });
});

describe("a retryable failure with attempts left", () => {
  beforeEach(() => {
    mocks.sendOnChannel.mockResolvedValue({ ok: false, error: "502 Bad Gateway", retryable: true });
  });

  it("records the failure and throws so BullMQ backs off", async () => {
    await expect(processJob(jobOnAttempt(2))).rejects.toThrow("502 Bad Gateway");

    // Throwing is how the retry happens. Returning normally would mark the job
    // complete and the notification would never be delivered.
    expect(recorded()[0]).toMatchObject({
      status: DeliveryStatus.failed,
      attempt: 2,
      error: "502 Bad Gateway",
    });
  });

  it("does not dead-letter while attempts remain", async () => {
    await processJob(jobOnAttempt(2)).catch(() => undefined);

    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
  });
});

describe("the last attempt", () => {
  it("dead-letters a retryable failure and stops retrying", async () => {
    mocks.sendOnChannel.mockResolvedValue({ ok: false, error: "502 Bad Gateway", retryable: true });

    const result = await processJob(jobOnAttempt(MAX_ATTEMPTS));

    // Returns rather than throws: another throw would schedule a sixth attempt.
    expect(result.status).toBe("dead-lettered");
    expect(recorded()[0]).toMatchObject({ status: DeliveryStatus.dead, attempt: MAX_ATTEMPTS });
  });

  it("says the retries ran out rather than that the notification was bad", async () => {
    mocks.sendOnChannel.mockResolvedValue({ ok: false, error: "502 Bad Gateway", retryable: true });

    await processJob(jobOnAttempt(MAX_ATTEMPTS));

    const [payload] = deadLettered();

    // These two look identical in the queue and mean opposite things to whoever
    // is reading it at 3am: fix the request, or wait for the provider.
    expect(payload.reason).toBe("retries exhausted");
    expect(payload.permanent).toBe(false);
    expect(payload.error).toBe("502 Bad Gateway");
  });
});

describe("a permanent failure", () => {
  beforeEach(() => {
    mocks.sendOnChannel.mockResolvedValue({
      ok: false,
      error: "address does not exist",
      retryable: false,
    });
  });

  it("gives up on the first try instead of burning all five", async () => {
    const result = await processJob(jobOnAttempt(1));

    // Five attempts on an invalid address costs five provider calls to learn
    // the same thing, and fills the dead-letter queue's budget for the day.
    expect(result.status).toBe("rejected");
    expect(mocks.sendOnChannel).toHaveBeenCalledTimes(1);
  });

  it("marks the dead-letter entry permanent", async () => {
    await processJob(jobOnAttempt(1));

    expect(deadLettered()[0]).toMatchObject({
      reason: "permanent failure",
      permanent: true,
    });
  });

  it("gives the dead-letter entry a unique id, so a repeat is not swallowed", async () => {
    await processJob(jobOnAttempt(1));
    await processJob(jobOnAttempt(1));

    const [first, second] = mocks.deadLetterAdd.mock.calls;

    // The dead-letter queue is never drained automatically, and BullMQ silently
    // drops an add whose id is taken - so a collision does not fail loudly, it
    // just loses the evidence. A timestamp is not unique enough here: two
    // failures in the same millisecond is exactly what a provider outage does.
    expect(first[2].jobId).not.toBe(second[2].jobId);
    expect(first[2].jobId).toMatch(/^n1-email@[0-9a-f-]{36}$/);
  });

  it("never puts a colon in the dead-letter job id", async () => {
    await processJob(jobOnAttempt(1));

    // BullMQ rejects custom job ids containing ':'. A three-part colon id slips
    // past that check by coincidence, and starts failing when BullMQ tightens
    // it - as an error on a queue nothing else reads.
    expect(mocks.deadLetterAdd.mock.calls[0][2].jobId).not.toContain(":");
  });

  it("keeps the entry after it is dead-lettered", async () => {
    await processJob(jobOnAttempt(1));

    // removeOnComplete would take the evidence away as soon as it is filed.
    expect(mocks.deadLetterAdd.mock.calls[0][2].removeOnComplete).toBe(false);
    expect(mocks.deadLetterAdd.mock.calls[0][2].removeOnFail).toBe(false);
  });
});

describe("things that are missing", () => {
  it("dead-letters a deleted notification instead of retrying it", async () => {
    mocks.db.notification.findUnique.mockResolvedValue(null);

    await expect(processJob(jobOnAttempt(1))).rejects.toThrow(/no longer exists/);

    expect(deadLettered()[0]).toMatchObject({
      reason: "notification row is missing",
      permanent: true,
    });
    expect(mocks.sendOnChannel).not.toHaveBeenCalled();
  });

  it("refuses to deliver to a user who does not own the notification", async () => {
    mocks.db.notification.findUnique.mockResolvedValue({ ...storedNotification, userId: "user-2" });

    await expect(processJob(jobOnAttempt(1))).rejects.toThrow(/does not own/);

    // The room is per user. Getting this wrong sends one person's notification
    // to another's devices, so it is worth failing loudly rather than trusting
    // the job payload.
    expect(mocks.sendOnChannel).not.toHaveBeenCalled();
    expect(deadLettered()[0]).toMatchObject({ reason: "user mismatch", permanent: true });
  });

  it("dead-letters a deleted recipient", async () => {
    mocks.db.user.findUnique.mockResolvedValue(null);

    await expect(processJob(jobOnAttempt(1))).rejects.toThrow(/no longer exists/);

    expect(deadLettered()[0]).toMatchObject({
      reason: "recipient no longer exists",
      permanent: true,
    });
  });
});

describe("a channel that throws instead of returning", () => {
  it("treats an unrecognised error as retryable and dead-letters on the last try", async () => {
    mocks.sendOnChannel.mockRejectedValue(new TypeError("cannot read properties of undefined"));

    await expect(processJob(jobOnAttempt(2))).rejects.toThrow(TypeError);

    // A bug in our own code should not dead-letter a user's notification on the
    // first try. Five attempts is a cheap ceiling.
    expect(recorded()[0]).toMatchObject({ status: DeliveryStatus.failed, attempt: 2 });
    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();

    await processJob(jobOnAttempt(MAX_ATTEMPTS)).catch(() => undefined);

    expect(deadLettered()[0]).toMatchObject({
      reason: "unexpected error",
      permanent: false,
    });
  });

  it("parks the job instead of spending an attempt when the daily email cap is hit", async () => {
    const retryAt = new Date("2026-10-04T00:00:00.000Z");
    mocks.sendOnChannel.mockRejectedValue(new DailyQuotaExceededError(300, retryAt));

    const result = await processJob(jobOnAttempt(1));

    // This is not a failure of the email. It is a scheduling problem, and it
    // must not count as one of the five tries or the notification dies while
    // waiting for the UTC day to roll over.
    expect(result.status).toBe("parked-until-quota-resets");
    expect(mocks.parkJob).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), retryAt, expect.any(String));
    expect(recorded()[0]).toMatchObject({ status: DeliveryStatus.queued, attempt: 1 });
    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
  });

  it("returns normally after parking, so BullMQ does not also count a failure", async () => {
    mocks.sendOnChannel.mockRejectedValue(new DailyQuotaExceededError(300, new Date()));

    await expect(processJob(jobOnAttempt(1))).resolves.toMatchObject({
      status: "parked-until-quota-resets",
    });
  });
});

describe("attempt accounting", () => {
  it("numbers attempts from one, whatever BullMQ reports", async () => {
    // BullMQ's attemptsMade is 0-based. Recording attempt 0 makes the
    // delivery_attempts table impossible to read against the retry policy.
    for (const [attemptsMade, expected] of [[0, 1], [1, 2], [4, 5]]) {
      vi.clearAllMocks();
      mocks.db.notification.findUnique.mockResolvedValue(storedNotification);
      mocks.db.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@b.test", name: null });
      mocks.db.deliveryAttempt.findFirst.mockResolvedValue(null);
      mocks.sendOnChannel.mockResolvedValue({ ok: true });

      await processJob({ id: "j", attemptsMade, data });

      expect(recorded()[0].attempt).toBe(expected);
    }
  });
});