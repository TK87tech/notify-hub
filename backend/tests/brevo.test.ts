import { describe, expect, it, vi } from "vitest";

const postMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: {
      messageId: "<brevo-message-123>",
    },
  }),
);

vi.mock("axios", () => ({
  default: {
    post: postMock,
  },
}));

describe("sendEmail", () => {
  it("sends a notification email through Brevo", async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret-at-least-16-chars";
    process.env.SERVICE_KEY = "test-service-key";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
    process.env.BREVO_API_KEY = "test-brevo-api-key";
    process.env.EMAIL_FROM = "no-reply@example.com";

    const { sendEmail } = await import("../src/channels/email/brevo.js");

    const result = await sendEmail({
      to: "user@example.com",
      toName: "Test User",
      title: "Task assigned",
      body: "You have been assigned a new task.",
      link: "https://example.com/notifications/123",
    });

    expect(postMock).toHaveBeenCalledOnce();

    expect(postMock).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.objectContaining({
        sender: {
          name: "NotifyHub",
          email: "no-reply@example.com",
        },
        to: [
          {
            email: "user@example.com",
            name: "Test User",
          },
        ],
        subject: "Task assigned",
        htmlContent: expect.stringContaining("You have been assigned a new task."),
        textContent: expect.stringContaining("You have been assigned a new task."),
      }),
      {
        headers: {
          accept: "application/json",
          "api-key": "test-brevo-api-key",
          "content-type": "application/json",
        },
        timeout: 10_000,
      },
    );

    expect(result).toEqual({
      providerRef: "<brevo-message-123>",
    });
  });

  it("throws a clear error when BREVO_API_KEY is missing", async () => {
    vi.resetModules();
    postMock.mockClear();
    process.env.BREVO_API_KEY = "";

    const { sendEmail } = await import("../src/channels/email/brevo.js");

    await expect(
      sendEmail({ to: "user@example.com", title: "Hi" }),
    ).rejects.toThrow("BREVO_API_KEY is not set");
    expect(postMock).not.toHaveBeenCalled();
  });
});
