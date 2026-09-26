import { describe, expect, it } from "vitest";

import { renderNotificationEmail } from "../src/channels/email/template.js";

describe("renderNotificationEmail", () => {
  it("renders a notification with a title, body, and link", () => {
    const result = renderNotificationEmail({
      title: "Task assigned",
      body: "You have been assigned a new task.",
      link: "https://example.com/notifications/123",
    });

    expect(result.subject).toBe("Task assigned");
    expect(result.html).toContain("Task assigned");
    expect(result.html).toContain("You have been assigned a new task.");
    expect(result.html).toContain("https://example.com/notifications/123");

    expect(result.text).toContain("Task assigned");
    expect(result.text).toContain("You have been assigned a new task.");
    expect(result.text).toContain("https://example.com/notifications/123");
  });

  it("renders correctly when body and link are missing", () => {
    const result = renderNotificationEmail({
      title: "System notification",
    });

    expect(result.subject).toBe("System notification");
    expect(result.html).toContain("System notification");
    expect(result.text).toBe("System notification");
  });
});