/**
 * The Channel interface and the registry.
 *
 * The interface exists so that adding SMS is one folder and one line. That only
 * works if every registered channel really honours it, which is what these
 * assertions check: they run each channel against the same context and require
 * the same contract from all three.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendPushNotification: vi.fn(),
  publishToUser: vi.fn(),
  db: {
    notification: {
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    device: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: mocks.db }));

vi.mock("../src/lib/queue.js", () => ({ enqueueNotification: vi.fn() }));

vi.mock("../src/realtime/publisher.js", () => ({ publishToUser: mocks.publishToUser }));

vi.mock("../src/channels/email/brevo.js", () => ({
  sendEmail: mocks.sendEmail,
  /**
   * Classes, not objects, because both channel wrappers decide what to do with a
   * failure using `instanceof`. A plain object in the mock would send them down
   * the catch-all branch and hide the behaviour being tested.
   */
  EmailDeliveryError: class EmailDeliveryError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean) {
      super(message);
      this.name = "EmailDeliveryError";
      this.retryable = retryable;
    }
  },
  isDeliverableAddress: () => true,
}));

vi.mock("../src/channels/push/fcm.js", () => ({
  sendPushNotification: mocks.sendPushNotification,
  PushNotConfiguredError: class PushNotConfiguredError extends Error {},
  isPushConfigured: () => true,
}));

import { getChannel, registeredChannels, sendOnChannel } from "../src/channels/registry.js";
import { CHANNEL_NAMES, isPermanentStatus, type ChannelContext } from "../src/channels/types.js";

const context: ChannelContext = {
  notification: {
    id: "n1",
    userId: "user-1",
    type: "task_assigned",
    title: "Task assigned",
    body: "You have a new task",
    link: "/tasks/7",
    priority: "normal",
    data: {},
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
  },
  recipient: { id: "user-1", email: "tk@notifyhub.test", name: "TK" },
  attempt: 1,
  attemptCount: 5,
};

beforeEach(() => {
  vi.clearAllMocks();

  // The happy path every channel starts from: the notification row is there and
  // belongs to this user, the provider accepts it, there is one device.
  mocks.db.notification.findUnique.mockResolvedValue({
    id: "n1",
    userId: "user-1",
    read: false,
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
  });
  mocks.db.notification.count.mockResolvedValue(1);
  mocks.db.device.findMany.mockResolvedValue([{ id: "d1", token: "token-1" }]);
  mocks.db.device.deleteMany.mockResolvedValue({ count: 0 });
  mocks.sendEmail.mockResolvedValue({ providerRef: "brevo-1" });
  mocks.sendPushNotification.mockResolvedValue({
    sentCount: 1,
    outcomes: [{ token: "token-1", sent: true, dead: false, providerRef: "fcm-1" }],
  });
});

describe("the registry", () => {
  it("has an implementation for every channel the schema knows about", () => {
    // A channel in the Prisma enum with no implementation is a notification that
    // gets created, queued, and then permanently fails five times into the
    // dead-letter queue. This is the assertion that makes that impossible.
    for (const name of CHANNEL_NAMES) {
      expect(getChannel(name), `no implementation for "${name}"`).toBeDefined();
    }
  });

  it("registers nothing that is not a channel the schema knows about", () => {
    // The reverse also matters: a leftover entry for a removed channel keeps
    // dead code alive and quietly passes a type check.
    const registered = registeredChannels().map((c) => c.name).sort();

    expect(registered).toEqual([...CHANNEL_NAMES].sort());
  });

  it("gives the same instance for the same name", () => {
    for (const name of CHANNEL_NAMES) {
      expect(getChannel(name)).toBe(getChannel(name));
    }
  });

  it("reports an unknown channel as a permanent failure rather than throwing", async () => {
    // A job naming a channel that no longer exists is a deployment mistake.
    // Throwing would put it in the retry loop; a permanent failure records the
    // attempt and dead-letters it, where the mistake is visible.
    const result = await sendOnChannel("carrier_pigeon" as never, context);

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.error).toMatch(/carrier_pigeon/);
  });
});

describe("every registered channel honours the same contract", () => {
  it("returns a result object, never throws, when the provider blows up", async () => {
    const boom = new Error("provider exploded");

    mocks.sendEmail.mockRejectedValue(boom);
    mocks.sendPushNotification.mockRejectedValue(boom);

    for (const channel of registeredChannels()) {
      // The worker treats a throw as a crash and a returned failure as a
      // recorded attempt. A channel that throws takes the batch down with it.
      const result = await channel.send(context).catch((err: unknown) => err);

      expect(result, `${channel.name} threw instead of returning`).not.toBe(boom);
      expect(result, `${channel.name} returned no result`).toHaveProperty("ok");
    }
  });

  it("says whether a failure is retryable, so the worker knows what to do", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("502 Bad Gateway"));

    const result = await sendOnChannel("email", context);

    expect(result.ok).toBe(false);
    expect(typeof (result.ok === false ? result.retryable : null)).toBe("boolean");
    expect(result.ok === false && result.error).toBeTruthy();
  });

  it("succeeds on the happy path for every channel", async () => {
    // A regression here means a channel that cannot deliver anything at all,
    // which is easy to introduce with a small edit to a provider wrapper.
    for (const channel of registeredChannels()) {
      const result = await channel.send(context);

      expect(result.ok, `${channel.name} failed on the happy path: ${JSON.stringify(result)}`).toBe(
        true,
      );
    }
  });

  it("passes the notification through to the provider without trimming it", async () => {
    const longTitle = "A".repeat(200);

    await sendOnChannel("email", {
      ...context,
      notification: { ...context.notification, title: longTitle },
    });

    // Truncation is the kind of bug that only shows up in somebody's inbox, long
    // after the commit that caused it.
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({
      to: context.recipient.email,
      title: longTitle,
    });
  });

  it("succeeds with nothing to do when the user has no devices", async () => {
    mocks.db.device.findMany.mockResolvedValue([]);

    const result = await sendOnChannel("push", context);

    // Skipped, not failed: retrying will not register a phone. Reporting this as
    // a failure is what fills the dead-letter queue with healthy users.
    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(mocks.sendPushNotification).not.toHaveBeenCalled();
  });

  it("deletes tokens FCM will never accept again", async () => {
    mocks.sendPushNotification.mockResolvedValue({
      sentCount: 0,
      outcomes: [{ token: "token-1", sent: false, dead: true, error: "UNREGISTERED" }],
    });

    await sendOnChannel("push", context);

    // An uninstalled app's token costs a request on every future notification
    // until it is removed.
    expect(mocks.db.device.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d1"] } },
    });
  });
});

describe("in-app ownership checks", () => {
  it("refuses to broadcast a notification that belongs to another user", async () => {
    mocks.db.notification.findUnique.mockResolvedValue({
      id: "n1",
      userId: "somebody-else",
      read: false,
      createdAt: new Date(),
    });

    const result = await sendOnChannel("in_app", context);

    // The room is per user, so broadcasting here would put somebody else's
    // notification in this user's feed, whatever the job payload claims.
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(mocks.publishToUser).not.toHaveBeenCalled();
  });

  it("treats a missing row as permanent, not as something to retry", async () => {
    mocks.db.notification.findUnique.mockResolvedValue(null);

    const result = await sendOnChannel("in_app", context);

    // The producer writes the row before the job exists, so a missing one means
    // the data is gone. Retrying five times will not bring it back.
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(mocks.publishToUser).not.toHaveBeenCalled();
  });
});

describe("isPermanentStatus", () => {
  it("treats a bad request or a gone resource as permanent", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(isPermanentStatus(status), `${status} should be permanent`).toBe(true);
    }
  });

  it("treats a busy or unwell provider as worth retrying", () => {
    // 429 especially: marking it permanent would discard messages exactly when
    // the provider is under load, which is the worst possible moment.
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isPermanentStatus(status), `${status} should retry`).toBe(false);
    }
  });
});