/**
 * Health and the operator endpoints.
 *
 * The reason to test these is that they are what a deploy gate and an alert
 * depend on. A readiness check that reports ready while Postgres is unreachable
 * is worse than no check: it sends traffic into a process that cannot serve it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  pingRedis: vi.fn(),
  queue: {
    getJobCounts: vi.fn(),
    isPaused: vi.fn(),
    getJobs: vi.fn(),
    getJob: vi.fn(),
  },
  db: {
    $queryRaw: vi.fn(),
    notification: { count: vi.fn() },
    deliveryAttempt: { groupBy: vi.fn() },
  },
  emailUsageToday: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.db }));

vi.mock("../src/lib/redis.js", () => ({
  pingRedis: mocks.pingRedis,
  // The gateway skips subscribing under test, so these are never reached. They
  // are here so the import does not fail.
  redisAvailable: false,
  subscriber: () => ({ status: "end", on: vi.fn(), subscribe: vi.fn(), quit: vi.fn() }),
  publisher: () => ({}),
  closeRedis: vi.fn(),
}));

vi.mock("../src/lib/email-quota.js", () => ({
  emailUsageToday: mocks.emailUsageToday,
  claimEmailSlot: vi.fn(),
  DailyQuotaExceededError: class DailyQuotaExceededError extends Error {},
  // Midnight tonight, like the real one. Returning `now` here would quietly
  // weaken every assertion about resetsAtUtc.
  endOfUtcDay: (now = new Date()) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)),
}));

vi.mock("../src/lib/queue.js", () => {
  const queue = () => mocks.queue;

  return {
    notificationQueueName: "notifications",
    emailQueueName: "notifications.email",
    deadLetterQueueName: "notifications.dlq",
    notificationQueue: queue,
    emailQueue: queue,
    deadLetterQueue: queue,
    enqueueNotification: vi.fn().mockResolvedValue("job-1"),
    jobIdFor: (d: { notificationId: string; channel: string }) => `${d.notificationId}-${d.channel}`,
    MAX_ATTEMPTS: 5,
  };
});

vi.mock("../src/middleware/auth.js", () => ({
  requireUser: (req: any, _res: any, next: any) => {
    req.user = { sub: "user-1", email: "tk@notifyhub.test" };
    next();
  },
  requireService: (req: any, res: any, next: any) => next(),
  currentUserId: (req: any) => req.user.sub,
}));

import { createApp } from "../src/app.js";

const app = createApp();

/** A healthy system: nothing waiting, nothing dead, Redis up. */
function healthyCounts() {
  return {
    waiting: 0,
    active: 0,
    delayed: 0,
    completed: 120,
    failed: 0,
    paused: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.db.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  mocks.pingRedis.mockResolvedValue(true);
  mocks.queue.getJobCounts.mockResolvedValue(healthyCounts());
  mocks.queue.isPaused.mockResolvedValue(false);
  mocks.queue.getJobs.mockResolvedValue([]);
  mocks.db.notification.count.mockResolvedValue(3);
  mocks.emailUsageToday.mockResolvedValue(12);
  mocks.db.deliveryAttempt.groupBy
    .mockResolvedValueOnce([{ status: "sent", _count: { _all: 100 } }])
    .mockResolvedValueOnce([
      { channel: "email", status: "sent", _count: { _all: 100 } },
    ]);
});

describe("GET /health", () => {
  it("is ok without touching a dependency", async () => {
    const res = await request(app).get("/health");

    // Render polls this every few seconds. If it pinged Postgres and Postgres
    // hiccuped, the deploy would be marked unhealthy for something that is not
    // a fault in this process.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
  });

  it("needs no token, because a health check cannot hold one", async () => {
    await request(app).get("/health").expect(200);
  });

  it("leaks nothing about the host", async () => {
    const res = await request(app).get("/health");

    expect(JSON.stringify(res.body)).not.toMatch(/version|host|password|postgres|redis/i);
  });
});

describe("GET /health/ready", () => {
  it("is ready when the database answers", async () => {
    const res = await request(app).get("/health/ready");

    // Redis is skipped under test rather than reported as ok - pretending it
    // passed would hide a real outage in the test suite.
    expect(res.status).toBe(200);
    expect(res.body.checks.database).toBe("ok");
  });

  it("is not ready, with a 503, when the database is unreachable", async () => {
    mocks.db.$queryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await request(app).get("/health/ready");

    // 503 is what a load balancer and Render's deploy gate read. Returning 200
    // here would send traffic into a process that cannot serve it.
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not ready");
    expect(res.body.checks.database).toBe("failed");
  });

  it("reports which dependency failed rather than just not being ready", async () => {
    mocks.db.$queryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await request(app).get("/health/ready");

    expect(res.body.checks).toHaveProperty("database");
  });

  it("does not put the connection string or the error in the response", async () => {
    mocks.db.$queryRaw.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"),
    );

    const res = await request(app).get("/health/ready");

    // This response is unauthenticated.
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|10\.0\.0\.5|password/i);
  });
});

describe("GET /internal/queue-stats", () => {
  it("reports depth, failure rate and the email quota", async () => {
    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.redis.reachable).toBe(true);
    expect(res.body.depth).toMatchObject({ total: 0, waiting: 0, active: 0, delayed: 0 });
    expect(res.body.deliveries).toMatchObject({ sent: 100, failed: 0, dead: 0, failureRate: 0 });
    expect(res.body.emailQuota).toMatchObject({ used: 12, limit: 300 });
    expect(res.body.emailQuota.resetsAtUtc).toMatch(/T00:00:00\.000Z$/);
  });

  it("sums the two delivery queues, and leaves the dead-letter queue out of depth", async () => {
    // One mock serves all three queues, so answer per call in mount order:
    // notifications, email, dead-letter.
    mocks.queue.getJobCounts
      .mockResolvedValueOnce(healthyCounts())
      .mockResolvedValueOnce({ ...healthyCounts(), waiting: 7, delayed: 3 })
      // Nothing consumes the DLQ, so real entries sit in `waiting`.
      .mockResolvedValueOnce({ ...healthyCounts(), waiting: 4 });

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.depth).toMatchObject({ total: 10, waiting: 7, delayed: 3 });
    // The dead-letter queue's size is reported on its own. Counting its entries
    // as backlog would mean a permanently full DLQ reads as a growing queue.
    expect(res.body.deadLetter.size).toBe(4);
  });

  it("excludes dead letters from the failure rate", async () => {
    mocks.db.deliveryAttempt.groupBy
      .mockReset()
      .mockResolvedValueOnce([
        { status: "sent", _count: { _all: 90 } },
        { status: "failed", _count: { _all: 10 } },
        { status: "dead", _count: { _all: 40 } },
      ])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // A dead letter is the system correctly giving up. Counting it as a failure
    // as well would report 50% when only one in ten deliveries actually failed.
    expect(res.body.deliveries.failureRate).toBe(0.1);
    expect(res.body.deliveries.dead).toBe(40);
  });

  it("reports no deliveries as a zero failure rate rather than NaN", async () => {
    mocks.db.deliveryAttempt.groupBy.mockReset().mockResolvedValue([]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // 0/0 is the state of every fresh deploy, and NaN serialises to null.
    expect(res.body.deliveries.failureRate).toBe(0);
  });

  it("is failing when Redis is unreachable", async () => {
    mocks.pingRedis.mockResolvedValue(false);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.status).toBe("failing");
    expect(res.body.redis.reachable).toBe(false);
  });

it("does not ask the queues for counts when Redis is unreachable", async () => {
    mocks.pingRedis.mockResolvedValue(false);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // The BullMQ clients are built with maxRetriesPerRequest: null so a job
    // survives a blip, which also means getJobCounts waits on a reconnect rather
    // than returning. Asking here would hang the one endpoint whose job is to
    // report the outage.
    expect(mocks.queue.getJobCounts).not.toHaveBeenCalled();

    // The shape still holds, so a dashboard polling this does not blow up on a
    // missing key at the exact moment it is trying to show the outage.
    expect(res.body.queues.notifications).toMatchObject({ name: "notifications", waiting: 0 });
    expect(res.body.queues.email).toMatchObject({ name: "notifications.email" });
    expect(res.body.depth).toMatchObject({ total: 0 });
  });

it("reports no processing time when Redis is unreachable", async () => {
    mocks.pingRedis.mockResolvedValue(false);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // The latency query is not run at all on this path, so null rather than a
    // stale-looking zero.
    expect(res.body.processing).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
  });

it("still answers when Redis is down and the email quota cannot be read", async () => {
    mocks.pingRedis.mockResolvedValue(false);
    mocks.emailUsageToday.mockRejectedValue(new Error("redis gone"));

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // A quota failure must not turn into a 500 here. redis.reachable: false is
    // already the whole story.
    expect(res.body.status).toBe("failing");
    expect(res.body.emailQuota.used).toBe(0);
  });

  it("is degraded when the queue is backing up", async () => {
    mocks.queue.getJobCounts
      .mockResolvedValueOnce({ ...healthyCounts(), waiting: 600 })
      .mockResolvedValueOnce(healthyCounts())
      .mockResolvedValueOnce(healthyCounts());

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.status).toBe("degraded");
  });

  it("is failing when more than a quarter of deliveries fail", async () => {
    mocks.db.deliveryAttempt.groupBy
      .mockReset()
      .mockResolvedValueOnce([
        { status: "sent", _count: { _all: 70 } },
        { status: "failed", _count: { _all: 30 } },
      ])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.deliveries.failureRate).toBe(0.3);
    expect(res.body.status).toBe("failing");
  });

  it("treats exactly a quarter as degraded, not failing", async () => {
    mocks.db.deliveryAttempt.groupBy
      .mockReset()
      .mockResolvedValueOnce([
        { status: "sent", _count: { _all: 75 } },
        { status: "failed", _count: { _all: 25 } },
      ])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // Both thresholds are strict inequalities, so 0.25 trips the 0.1 warning but
    // not the 0.25 breach. Pinned here so the boundary is a decision rather
    // than an accident of using > instead of >=.
    expect(res.body.deliveries.failureRate).toBe(0.25);
    expect(res.body.status).toBe("degraded");
  });

  it("says a paused queue is paused, rather than reporting a made-up count", async () => {
    mocks.queue.isPaused.mockResolvedValue(true);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // A paused queue is the single most useful thing to know when notifications
    // stop arriving, and BullMQ reports it as a flag rather than a job count.
    expect(res.body.queues.notifications.paused).toBe(true);
  });

  it("does not tell a user who they are", async () => {
    const res = await request(app).get("/internal/queue-stats");

    expect(res.body).not.toHaveProperty("you");
  });
});

describe("processing time", () => {
  it("reports the median and the 95th percentile of producer-to-provider latency", async () => {
    mocks.db.$queryRaw.mockResolvedValue([{ p50: 412.4, p95: 8390.9, samples: 128 }]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.processing).toEqual({ p50Ms: 412, p95Ms: 8391, samples: 128 });
  });

  it("reports nulls rather than NaN when nothing has been delivered yet", async () => {
    mocks.db.$queryRaw.mockResolvedValue([{ p50: null, p95: null, samples: 0 }]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // Every fresh deploy is in this state. NaN would serialise to null, and 0
    // would be a lie that suggests deliveries are instant.
    expect(res.body.processing).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
  });

  it("rounds to whole milliseconds, since a float here buys nothing", async () => {
    mocks.db.$queryRaw.mockResolvedValue([{ p50: 412.6, p95: 8390.4, samples: 1 }]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    expect(res.body.processing).toEqual({ p50Ms: 413, p95Ms: 8390, samples: 1 });
  });

  it("keeps p50 and p95 apart so retries do not hide inside an average", async () => {
    mocks.db.$queryRaw.mockResolvedValue([{ p50: 300, p95: 12000, samples: 50 }]);

    const res = await request(app).get("/internal/queue-stats").expect(200);

    // A mean over these numbers lands near 2.5s and describes neither the
    // healthy path or the tail. The gap is the signal.
    expect(res.body.processing.p95Ms / res.body.processing.p50Ms).toBe(40);
  });
});

describe("GET /api/v1/ops/queue-stats", () => {
  it("adds the caller's own unread count to the same numbers", async () => {
    const res = await request(app).get("/api/v1/ops/queue-stats").expect(200);

    expect(res.body.you).toEqual({ unreadCount: 3 });
    expect(res.body.status).toBe("ok");
  });

  it("counts only the caller's notifications", async () => {
    await request(app).get("/api/v1/ops/queue-stats").expect(200);

    // One shared team account is the documented trade-off here; scoping the
    // count is still what stops it reading as somebody else's inbox.
    expect(mocks.db.notification.count).toHaveBeenCalledWith({
      where: { userId: "user-1", read: false },
    });
  });
});

describe("GET /internal/dead-letters", () => {
  it("returns the queue's contents newest first", async () => {
    mocks.queue.getJobs.mockResolvedValue([
      { id: "old", timestamp: 1_000, data: { notificationId: "n1", reason: "old" } },
      { id: "new", timestamp: 2_000, data: { notificationId: "n2", reason: "new" } },
    ]);

    const res = await request(app).get("/internal/dead-letters").expect(200);

    // BullMQ returns them oldest first, and the newest failure is the one worth
    // reading.
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual(["new", "old"]);
    expect(res.body.items[0]).toMatchObject({ id: "new", notificationId: "n2", reason: "new" });
  });

  it("copes with an entry whose payload is missing fields", async () => {
    mocks.queue.getJobs.mockResolvedValue([{ id: "bare", timestamp: 1_000, data: {} }]);

    const res = await request(app).get("/internal/dead-letters").expect(200);

    // A hand-added job with an unexpected shape should not take the endpoint
    // down - that is how you lose sight of the queue you came to read.
    expect(res.body.items[0]).toMatchObject({
      id: "bare",
      notificationId: null,
      channel: null,
      permanent: false,
    });
  });

  it("caps how many it returns", async () => {
    await request(app).get("/internal/dead-letters?limit=5000").expect(200);

    expect(mocks.queue.getJobs).toHaveBeenCalledWith(expect.anything(), 0, 99);
  });
});

describe("POST /internal/dead-letters/requeue", () => {
  it("404s for an id that is not in the queue", async () => {
    mocks.queue.getJob.mockResolvedValue(null);

    const res = await request(app).post("/internal/dead-letters/requeue?id=nope").expect(404);

    expect(res.body.error.code).toBe("not_found");
  });

  it("re-queues the delivery and removes the dead-letter entry", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    mocks.queue.getJob.mockResolvedValue({
      id: "dlq-1",
      remove,
      data: {
        notificationId: "n1",
        userId: "user-1",
        channel: "email",
        priority: "normal",
        attempt: 5,
      },
    });

    const res = await request(app).post("/internal/dead-letters/requeue?id=dlq-1").expect(200);

    expect(res.body).toMatchObject({ status: "requeued", notificationId: "n1", channel: "email" });

    // A new id, or BullMQ ignores the add while the original job is retained;
    // and a fresh attempt count, or the requeue gets a single try.
    const { enqueueNotification } = await import("../src/lib/queue.js");
    const [jobData, , jobId] = vi.mocked(enqueueNotification).mock.calls.at(-1)!;
    expect(jobData.attempt).toBe(1);
    expect(jobId).toMatch(/^n1-email@requeue-/);

    // Removing the entry is what stops somebody re-running this every ten
    // minutes out of a habit formed the first time it worked.
    expect(remove).toHaveBeenCalledOnce();
  });
});