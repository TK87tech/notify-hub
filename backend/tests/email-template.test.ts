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

  it("escapes HTML in the title and body", () => {
    const result = renderNotificationEmail({
      title: "<b>x</b>",
      body: `<img src=x onerror="alert(1)"> & 'quotes'`,
    });

    expect(result.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(result.html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quotes&#39;",
    );
    expect(result.html).not.toContain("<b>");
    expect(result.html).not.toContain("<img");
  });

  it("drops links that are not http or https", () => {
    for (const link of ["javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      const result = renderNotificationEmail({ title: "Hi", link });

      expect(result.html).not.toContain("href");
      expect(result.text).toBe("Hi");
    }
  });

  it("escapes quotes inside an allowed link", () => {
    const result = renderNotificationEmail({
      title: "Hi",
      link: `https://example.com/?q="><script>`,
    });

    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain('href="https://example.com/?q=%22%3E%3Cscript%3E"');
  });
});