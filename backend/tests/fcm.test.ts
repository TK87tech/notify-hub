import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEachForMulticast: vi.fn(),
  getMessaging: vi.fn(),
  getApps: vi.fn(),
  initializeApp: vi.fn(),
  cert: vi.fn(),
}));

vi.mock("firebase-admin/app", () => ({
  cert: mocks.cert,
  getApps: mocks.getApps,
  initializeApp: mocks.initializeApp,
}));

vi.mock("firebase-admin/messaging", () => ({
  getMessaging: mocks.getMessaging,
}));

import { sendPushNotification } from "../src/channels/push/fcm.js";

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getApps.mockReturnValue([]);
  mocks.initializeApp.mockImplementation((options) => ({ options }));
  mocks.cert.mockImplementation((options) => options);
  mocks.getMessaging.mockReturnValue({
    sendEachForMulticast: mocks.sendEachForMulticast,
  });

  process.env.FIREBASE_PROJECT_ID = "test-project";
  process.env.FIREBASE_CLIENT_EMAIL =
    "firebase@test.iam.gserviceaccount.com";
  process.env.FIREBASE_PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\\nTEST\\n-----END PRIVATE KEY-----\\n";
});

describe("FCM push channel", () => {
  it("returns an empty result when there are no tokens", async () => {
    const result = await sendPushNotification({
      tokens: [],
      title: "Test notification",
    });

    expect(result).toEqual({
      successCount: 0,
      failureCount: 0,
      responses: [],
    });

    expect(mocks.getApps).not.toHaveBeenCalled();
    expect(mocks.getMessaging).not.toHaveBeenCalled();
    expect(mocks.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("sends a multicast notification and maps provider results", async () => {
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        {
          success: true,
          messageId: "msg-123",
        },
        {
          success: false,
          error: {
            message: "registration-token-not-registered",
          },
        },
      ],
    });

    const result = await sendPushNotification({
      tokens: ["token-1", "token-2"],
      title: "Task assigned",
      body: "Design review",
      data: {
        notificationId: "n1",
      },
    });

    expect(mocks.cert).toHaveBeenCalledWith({
      projectId: "test-project",
      clientEmail: "firebase@test.iam.gserviceaccount.com",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
    });

    expect(mocks.initializeApp).toHaveBeenCalled();

    expect(mocks.getMessaging).toHaveBeenCalled();

    expect(mocks.sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ["token-1", "token-2"],
      notification: {
        title: "Task assigned",
        body: "Design review",
      },
      data: {
        notificationId: "n1",
      },
    });

    expect(result).toEqual({
      successCount: 1,
      failureCount: 1,
      responses: [
        {
          token: "token-1",
          success: true,
          providerRef: "msg-123",
        },
        {
          token: "token-2",
          success: false,
          error: "registration-token-not-registered",
        },
      ],
    });
  });

  it("throws a clear error when Firebase configuration is missing", async () => {
    delete process.env.FIREBASE_PROJECT_ID;

    await expect(
      sendPushNotification({
        tokens: ["token-1"],
        title: "Test notification",
      }),
    ).rejects.toThrow("Firebase configuration is missing");
  });
});
