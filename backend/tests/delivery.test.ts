/**
 * The delivery facade and the queue's own rules.
 *
 * The point of these tests is the boundary: `lib/delivery.ts` exists so channel
 * code never touches BullMQ (issue #16). If a BullMQ concept leaks into the
 * facade, one of these assertions is what notices.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueNotification: vi.fn(),
}));

vi.mock("../src/lib/queue.js", () => ({
  enqueueNotification: mocks.enqueueNotification,
}));

import {
  deliverNow,
  resolveDeliveryTime,
  scheduleDelivery,
} from "../src/lib/delivery.js";
import type { QuietHours } from "../src/lib/quiet-hours.js";

/** 22:00 to 07:00 in Lagos, which is the window the seed data uses. */
const overnight: QuietHours = {
  start: "22:00",
  end: "07:00",
  timezone: "Africa/Lagos",
};

/**
 * 22:30 UTC is 23:30 in Lagos, so this is inside the 22:00-07:00 window.
 * Seven and a half hours of it are left: half an hour to midnight, then seven.
 */
const duringQuietHours = new Date("2026-09-30T22:30:00.000Z");

const request = {
  notificationId: "n1",
  userId: "u1",
  channels: ["in_app" as const, "email" as const],
  priority: "normal" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueNotification.mockResolvedValue("job-1");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveDeliveryTime", () => {
  it("sends immediately when there are no quiet hours", () => {
    const now = new Date("2026-09-30T22:30:00.000Z");

    expect(resolveDeliveryTime("low", { now }).getTime()).toBe(now.getTime());
  });

  it("delays a low-priority notification until quiet hours end", () => {
    const when = resolveDeliveryTime("low", {
      now: duringQuietHours,
      quietHours: overnight,
    });

    // Just over seven and a half hours, plus the one-second buffer quiet-hours.ts
    expect(when.getTime() - duringQuietHours.getTime()).toBe(
      7.5 * 60 * 60 * 1000 + 1000,
    );
  });

  it("never delays an urgent notification, whatever the quiet hours say", () => {
    const when = resolveDeliveryTime("urgent", {
      now: duringQuietHours,
      quietHours: overnight,
    });

    expect(when.getTime()).toBe(duringQuietHours.getTime());
  });

  it("never delays a normal notification", () => {
    // docs/BELL-DECISIONS.md: only low is delayed. Delaying normal by a whole
    // night is the kind of surprise that makes people turn notifications off.
    const when = resolveDeliveryTime("normal", {
      now: duringQuietHours,
      quietHours: overnight,
    });

    expect(when.getTime()).toBe(duringQuietHours.getTime());
  });

  it("lets an explicit deliverAt override quiet hours", () => {
    const deliverAt = new Date("2026-10-04T09:00:00.000Z");

    const when = resolveDeliveryTime("low", {
      now: duringQuietHours,
      quietHours: overnight,
      deliverAt,
    });

    expect(when.getTime()).toBe(deliverAt.getTime());
  });
});

describe("scheduleDelivery", () => {
  it("queues one job per channel", async () => {
    const outcome = await scheduleDelivery(request, { now: duringQuietHours });

    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(outcome.jobs.map((job) => job.channel)).toEqual(["in_app", "email"]);
    expect(outcome.delayed).toBe(false);
  });

  it("passes the queue a plain job, with no BullMQ concepts in the facade", async () => {
    await scheduleDelivery(request, { now: duringQuietHours });

    for (const [data, delay] of mocks.enqueueNotification.mock.calls) {
      expect(Object.keys(data as object).sort()).toEqual([
        "attempt",
        "channel",
        "notificationId",
        "priority",
        "userId",
      ]);
      // The only queue-specific thing that crosses the boundary is the delay,
      // in milliseconds. That is the one number a caller genuinely needs.
      expect(delay).toBe(0);
    }
  });

  it("reports the quiet-hours delay and passes it to the queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(duringQuietHours);

    const outcome = await scheduleDelivery(
      { ...request, priority: "low" },
      { quietHours: overnight },
    );

    expect(outcome.delayed).toBe(true);

    for (const [, delay] of mocks.enqueueNotification.mock.calls) {
      expect(delay).toBe(7.5 * 60 * 60 * 1000 + 1000);
    }
  });

  it("marks every job with the same delivery time", async () => {
    const outcome = await scheduleDelivery(request, {
      now: duringQuietHours,
      quietHours: overnight,
      deliverAt: new Date("2026-10-04T09:00:00.000Z"),
    });

    const times = new Set(outcome.jobs.map((job) => job.scheduledFor.getTime()));

    expect(times.size).toBe(1);
  });
});

describe("deliverNow", () => {
  it("is scheduleDelivery without an explicit time, so quiet hours still apply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(duringQuietHours);

    const outcome = await deliverNow({ ...request, priority: "low" }, { quietHours: overnight });

    expect(outcome.delayed).toBe(true);

    const [, delay] = mocks.enqueueNotification.mock.calls[0];
    expect(delay).toBe(7.5 * 60 * 60 * 1000 + 1000);
  });
});