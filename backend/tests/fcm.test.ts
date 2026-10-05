/**
 * The FCM provider and the push Channel.
 *
 * The provider is tested against a fake firebase-admin, which is the whole
 * point of the Channel interface: no network, no credentials, and every branch
 * of the token-failure logic reachable.
 *
 * The env module is mocked rather than mutated, because config/env.ts reads
 * process.env once at import and a test that sets a variable afterwards is
 * testing nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEachForMulticast: vi.fn(),
  getMessaging: vi.fn(),
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  cert: vi.fn(),
  deviceFindMany: vi.fn(),
  deviceDeleteMany: vi.fn(),
  env: {
    FCM_PROJECT_ID: "test-project",
    FCM_CLIENT_EMAIL: "firebase@test.iam.gserviceaccount.com",
    FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n",
    APP_URL: "https://notify.example.com",
  },
}));

vi.mock("firebase-admin/app", () => ({
  cert: mocks.cert,
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock("firebase-admin/messaging", () => ({
  getMessaging: mocks.getMessaging,
}));

vi.mock("../src/config/env.js", () => ({
  env: mocks.env,
  isProduction: false,
  isTest: true,
  allowedOrigins: ["http://localhost:5173"],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    device: {
      findMany: mocks.deviceFindMany,
      deleteMany: mocks.deviceDeleteMany,
    },
  },
}));

import {
  isPushConfigured,
  resetFirebaseAppForTests,
  sendPushNotification,
} from "../src/channels/push/fcm.js";
import { pushChannel } from "../src/channels/push/channel.js";

const context = {
  notification: {
    id: "n1",
    userId: "user-1",
    type: "task_assigned",
    title: "Task assigned",
    body: "Design review",
    link: "/tasks/91",
    priority: "normal" as const,
    data: {},
    createdAt: new Date("2026-09-21T08:14:00.000Z"),
  },
  recipient: { id: "user-1", email: "tk@notifyhub.test", name: "TK" },
  attempt: 1,
  attemptCount: 5,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetFirebaseAppForTests();

  mocks.env.FCM_PROJECT_ID = "test-project";
  mocks.env.FCM_CLIENT_EMAIL = "firebase@test.iam.gserviceaccount.com";
  mocks.env.FCM_PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n";

  mocks.getApps.mockReturnValue([]);
  mocks.initializeApp.mockImplementation((options) => ({ options }));
  mocks.cert.mockImplementation((options) => options);
  mocks.getMessaging.mockReturnValue({
    sendEachForMulticast: mocks.sendEachForMulticast,
  });
});

describe("isPushConfigured", () => {
  it("is true when all three Firebase values are present", () => {
    expect(isPushConfigured()).toBe(true);
  });

  it("is false when the private key is missing", () => {
    mocks.env.FCM_PRIVATE_KEY = "";
    expect(isPushConfigured()).toBe(false);
  });
});

describe("sendPushNotification", () => {
  it("returns an empty result without touching firebase when there are no tokens", async () => {
    const result = await sendPushNotification({ tokens: [], title: "Test" });

    expect(result).toEqual({ sentCount: 0, outcomes: [] });
    expect(mocks.getMessaging).not.toHaveBeenCalled();
    expect(mocks.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("builds the firebase app from the validated env, unescaping the private key", async () => {
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [{ success: true, messageId: "msg-123" }],
    });

    await sendPushNotification({ tokens: ["token-1"], title: "Task assigned" });

    // A key copied out of the Firebase console arrives with literal \n
    // sequences. Passing them through untouched is the classic FCM setup bug,
    // and it fails as a confusing signature error at send time.
    expect(mocks.cert).toHaveBeenCalledWith({
      projectId: "test-project",
      clientEmail: "firebase@test.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
    });
  });

  it("maps a per-token success and failure", async () => {
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true, messageId: "msg-123" },
        {
          success: false,
          error: {
            code: "messaging/registration-token-not-registered",
            message: "Requested entity was not found.",
          },
        },
      ],
    });

    const result = await sendPushNotification({
      tokens: ["token-1", "token-2"],
      title: "Task assigned",
      body: "Design review",
      link: "/tasks/91",
    });

    expect(result.sentCount).toBe(1);
    expect(result.outcomes).toEqual([
      { token: "token-1", sent: true, providerRef: "msg-123" },
      {
        token: "token-2",
        sent: false,
        error: "messaging/registration-token-not-registered: Requested entity was not found.",
        dead: true,
      },
    ]);
  });

  it("marks a transient failure as retryable rather than dead", async () => {
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [
        {
          success: false,
          error: { code: "messaging/internal-error", message: "try again" },
        },
      ],
    });

    const result = await sendPushNotification({ tokens: ["token-1"], title: "x" });

    expect(result.outcomes[0].dead).toBe(false);
  });
});

describe("push channel", () => {
  it("skips, and says why, when Firebase is not configured", async () => {
    mocks.env.FCM_PROJECT_ID = "";

    const result = await pushChannel.send(context);

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(result.ok && result.detail).toMatch(/FCM_PROJECT_ID/);
    expect(mocks.deviceFindMany).not.toHaveBeenCalled();
  });

  it("skips cleanly when the user has no devices", async () => {
    mocks.deviceFindMany.mockResolvedValue([]);

    const result = await pushChannel.send(context);

    expect(result).toMatchObject({ ok: true, skipped: true });
    expect(mocks.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("succeeds and deletes tokens FCM will never accept again", async () => {
    mocks.deviceFindMany.mockResolvedValue([
      { id: "d1", token: "good" },
      { id: "d2", token: "stale" },
    ]);

    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true, messageId: "msg-1" },
        {
          success: false,
          error: { code: "messaging/invalid-registration-token", message: "bad" },
        },
      ],
    });

    const result = await pushChannel.send(context);

    expect(result.ok).toBe(true);
    // Only the dead token is removed. Dropping the working one would silently
    // unsubscribe a user who is receiving notifications fine.
    expect(mocks.deviceDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["d2"] } },
    });
  });

  it("reports success when part of the batch fails, so a bad phone does not fail the notification", async () => {
    mocks.deviceFindMany.mockResolvedValue([
      { id: "d1", token: "good" },
      { id: "d2", token: "stale" },
    ]);

    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true, messageId: "msg-1" },
        { success: false, error: { code: "messaging/internal-error", message: "flaky" } },
      ],
    });

    const result = await pushChannel.send(context);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.detail).toBe("1/2 devices reached");
  });

  it("fails permanently when every token is dead", async () => {
    mocks.deviceFindMany.mockResolvedValue([{ id: "d1", token: "stale" }]);

    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [
        {
          success: false,
          error: { code: "messaging/registration-token-not-registered", message: "gone" },
        },
      ],
    });

    const result = await pushChannel.send(context);

    expect(result.ok).toBe(false);
    // Nothing to retry: those tokens will never work.
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("stays retryable when the provider itself is having a bad day", async () => {
    mocks.deviceFindMany.mockResolvedValue([{ id: "d1", token: "flaky" }]);

    mocks.sendEachForMulticast.mockRejectedValue(new Error("ECONNRESET"));

    const result = await pushChannel.send(context);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(true);
  });
});