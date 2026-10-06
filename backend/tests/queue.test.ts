/**
 * Queue configuration: priorities, retries, the dead-letter queue and the
 * Brevo rate limit.
 *
 * These assert the numbers the retry policy depends on. If somebody "tidies up"
 * the backoff to a flat two seconds, the exponential-growth promise in
 * docs/BELL-DECISIONS.md stops being true and nothing else would notice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  queueConstructor: vi.fn(),
  /**
   * Every Queue ever constructed in this process, never cleared. The queue
   * handles are memoised at module scope, so by the time a later test runs they
   * were built by an earlier one - and the options each queue was built with
   * only exist at construction time.
   */
  constructed: [] as Array<{ name: string; options: Record<string, unknown> }>,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(name: string, options: Record<string, unknown>) {
      mocks.queueConstructor(name, options);
      mocks.constructed.push({ name, options });
    }

    add = mocks.add;
    getJob = mocks.getJob;
  },
  QueueEvents: class {},
  Worker: class {},
}));

vi.mock("ioredis", () => ({
  Redis: class {
    constructor(public options: unknown) {}
  },
}));

import {
  BACKOFF_BASE_MS,
  BULLMQ_PRIORITY,
  MAX_ATTEMPTS,
  deadLetterQueue,
  deadLetterQueueName,
  emailQueueName,
  enqueueNotification,
  jobIdFor,
  notificationQueueName,
  parkJob,
  queueForChannel,
  workerLimiterFor,
} from "../src/lib/queue.js";

const job = {
  notificationId: "n1",
  userId: "u1",
  channel: "in_app" as const,
  priority: "normal" as const,
  attempt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue({ id: "job-1" });
  mocks.getJob.mockResolvedValue(null);
});

describe("priority mapping", () => {
  it("maps the three priorities onto distinct BullMQ priorities, urgent first", () => {
    expect(BULLMQ_PRIORITY.urgent).toBeLessThan(BULLMQ_PRIORITY.normal);
    expect(BULLMQ_PRIORITY.normal).toBeLessThan(BULLMQ_PRIORITY.low);
  });

  it("leaves room for a fourth level without renumbering", () => {
    // A job already sitting in Redis keeps the meaning it was queued with, so
    // the existing numbers must not be shifted to make space.
    expect(BULLMQ_PRIORITY.normal - BULLMQ_PRIORITY.urgent).toBeGreaterThan(1);
    expect(BULLMQ_PRIORITY.low - BULLMQ_PRIORITY.normal).toBeGreaterThan(1);
  });
});

describe("retry policy", () => {
  it("allows five attempts with exponential backoff starting at two seconds", async () => {
    await enqueueNotification(job);

    const [, , options] = mocks.add.mock.calls[0];

    expect(options.attempts).toBe(MAX_ATTEMPTS);
    expect(options.backoff).toEqual({ type: "exponential", delay: BACKOFF_BASE_MS });
    expect(BACKOFF_BASE_MS).toBe(2_000);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("keeps failed jobs so a failure can be explained later", async () => {
    await enqueueNotification(job);

    const [, , options] = mocks.add.mock.calls[0];

    // Removing failed jobs means the evidence disappears with them.
    expect(options.removeOnFail.count).toBeGreaterThan(0);
    expect(options.removeOnComplete).toBeTruthy();
  });
});

describe("job ids and idempotency", () => {
  it("keys a job on the notification and channel, so a repeat enqueue is a no-op", async () => {
    await enqueueNotification(job);

    const [, , options] = mocks.add.mock.calls[0];

    expect(options.jobId).toBe("n1-in_app");
    expect(jobIdFor(job)).toBe("n1-in_app");
  });

  it("never puts a colon in a custom job id, which BullMQ refuses", async () => {
    // BullMQ joins a repeatable job's name, key and checksum with ':' and
    // throws "Custom Id cannot contain :" on anything else containing one. The
    // check lives in Job.validateOptions at runtime, so a colon here breaks
    // every enqueue and nothing catches it until notifications stop arriving.
    for (const channel of ["in_app", "email", "push"] as const) {
      expect(jobIdFor({ notificationId: "clx0a1b2c3d4e5f6g7h8i", channel })).not.toContain(":");
    }

    await enqueueNotification({ ...job, notificationId: "clx0a1b2c3d4e5f6g7h8i" });

    expect(mocks.add.mock.calls[0][2].jobId).not.toContain(":");
  });

  it("refuses an id that already contains a colon, instead of letting BullMQ throw", () => {
    // Only reachable if an id comes from somewhere other than our own `id`
    // column, but the error has to arrive from here. BullMQ's own message names
    // neither notifications nor BullMQ, and surfaces at the API's error handler
    // long after the value that caused it has scrolled past.
    expect(() => jobIdFor({ notificationId: "a:b:c", channel: "in_app" })).toThrow(
      /cannot contain ":"/,
    );
  });

  it("gives the same channel the same id and different channels different ids", () => {
    // This is what keeps two channels of one notification from colliding, which
    // is the whole reason a job is per (notification, channel) and not per
    // notification.
    const ids = (["in_app", "email", "push"] as const).map((channel) =>
      jobIdFor({ notificationId: "n1", channel }),
    );

    expect(new Set(ids).size).toBe(3);
    expect(jobIdFor({ notificationId: "n1", channel: "email" })).toBe(
      jobIdFor({ notificationId: "n1", channel: "email" }),
    );
  });

  it("reads back the channel from the end of the id", () => {
    // The operations endpoints list jobs by id, so being able to see which
    // channel an id belongs to without a database round trip is the point.
    for (const channel of ["in_app", "email", "push"] as const) {
      expect(jobIdFor({ notificationId: "n1", channel }).endsWith(`-${channel}`)).toBe(true);
    }
  });
});

describe("priority and delay together", () => {
  it("sets a priority when the job is not delayed", async () => {
    await enqueueNotification(job, 0);

    const [, , options] = mocks.add.mock.calls[0];

    expect(options.priority).toBe(BULLMQ_PRIORITY.normal);
  });

  it("omits the priority when the job is delayed, because it would be ignored", async () => {
    // BullMQ accepts both, but priority orders the waiting list and a delayed
    // job is promoted straight out of the delayed set on its timestamp. Storing
    // a number that does nothing invites somebody to trust it later.
    await enqueueNotification(job, 60_000);

    const [, , options] = mocks.add.mock.calls[0];

    expect(options.delay).toBe(60_000);
    expect(options).not.toHaveProperty("priority");
  });
});

describe("email rate limit", () => {
  it("is a worker option for the email queue only", () => {
    // BullMQ ignores a limiter on the Queue, so this is the only place it works.
    expect(workerLimiterFor(emailQueueName)).toEqual({ max: 20, duration: 60_000 });
    expect(workerLimiterFor(notificationQueueName)).toBeUndefined();
  });
});

describe("queue routing", () => {
  it("puts email on its own queue so the Brevo limit cannot stall in-app delivery", () => {
    expect(queueForChannel("email")).toBe(queueForChannel("email"));
    expect(queueForChannel("in_app")).not.toBe(queueForChannel("email"));
  });

  it("puts no limiter on any Queue, where BullMQ would silently ignore it", () => {
    queueForChannel("email");
    queueForChannel("in_app");
    deadLetterQueue();

    // The email limit lives on the Worker (workerLimiterFor, above). A limiter
    // here is accepted, does nothing, and reads as if Brevo were protected.
    for (const name of [emailQueueName, notificationQueueName, deadLetterQueueName]) {
      expect(mocks.constructed.find((entry) => entry.name === name)!.options).not.toHaveProperty("limiter");
    }
  });

  it("opens one connection per queue and never more", () => {
    // Three queues, three connections. A leak here is invisible until Redis
    // runs out of file descriptors in production.
    queueForChannel("in_app");
    queueForChannel("email");
    queueForChannel("push");
    deadLetterQueue();

    const perName = mocks.constructed.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.name] = (acc[entry.name] ?? 0) + 1;
      return acc;
    }, {});

    for (const count of Object.values(perName)) {
      expect(count).toBe(1);
    }
  });
});

describe("parkJob", () => {
  it("removes the waiting job and re-adds it under a fresh id with a delay", async () => {
    mocks.getJob.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
    mocks.add.mockResolvedValue({ id: "parked-1" });

    const until = new Date(Date.now() + 3_600_000);
    const id = await parkJob(job, until, "email daily limit reached");

    expect(mocks.getJob).toHaveBeenCalledWith("n1-in_app");
    expect(mocks.add.mock.calls[0][2].delay).toBeGreaterThan(3_500_000);

    // A different id, or the re-add would be rejected as the very duplicate it
    // just removed, and the job would vanish instead of being parked.
    expect(mocks.add.mock.calls[0][2].jobId).not.toBe("n1-in_app");
    expect(mocks.add.mock.calls[0][2].jobId).not.toContain(":");
    expect(id).toBe("parked-1");
  });

  it("keeps the attempts the job has already used", async () => {
    mocks.getJob.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });

    await parkJob({ ...job, attempt: 3 }, new Date(Date.now() + 1_000), "quota");

    // BullMQ starts a re-added job at attemptsMade 0. Without carrying the count
    // over, a job that has already failed twice gets another five tries.
    expect(mocks.add.mock.calls[0][2].attempts).toBe(MAX_ATTEMPTS - 2);
  });

  it("still re-adds the job when the original could not be found", async () => {
    mocks.getJob.mockResolvedValue(null);
    mocks.add.mockResolvedValue({ id: "parked-2" });

    const id = await parkJob(job, new Date(Date.now() + 1_000), "quota");

    expect(id).toBe("parked-2");
  });

  it("gives two parks for different reasons two different ids", async () => {
    mocks.getJob.mockResolvedValue(null);

    await parkJob(job, new Date(Date.now() + 1_000), "quota");
    await parkJob(job, new Date(Date.now() + 9_000), "quota");

    const [first, second] = mocks.add.mock.calls;

    // If both landed on the same id the second would be swallowed as a
    // duplicate and one of the two delays would never be honoured.
    expect(first[2].jobId).not.toBe(second[2].jobId);
  });
});