/**
 * The alert's judgement, which is the only part worth testing. Whether the
 * webhook actually delivered is not something a unit test can honestly check,
 * and pretending otherwise is how alerting quietly stops working.
 */

import { describe, expect, it } from "vitest";

import { alertDecision, webhookBody, type QueueStatsLike } from "../src/lib/alert.js";

function stats(overrides: Partial<QueueStatsLike> = {}): QueueStatsLike {
  return {
    status: "ok",
    redis: { reachable: true },
    deadLetter: { size: 0, warnThreshold: 10, failThreshold: 50 },
    depth: { total: 0, delayed: 0 },
    ...overrides,
  };
}

describe("alertDecision", () => {
  it("says nothing when everything is healthy", () => {
    expect(alertDecision(stats())).toBeNull();
  });

  it("shouts about Redis before anything else", () => {
    const alert = alertDecision(
      stats({ redis: { reachable: false }, status: "failing", deadLetter: { size: 99, warnThreshold: 10, failThreshold: 50 } }),
    );

    // Redis explains every other number. Reporting the backlog as the headline
    // would send somebody to restart a worker that was never the problem.
    expect(alert?.level).toBe("critical");
    expect(alert?.headline).toMatch(/Redis/);
  });

  it("is critical when the endpoint already calls the system failing", () => {
    const alert = alertDecision(stats({ status: "failing" }));

    expect(alert?.level).toBe("critical");
  });

  it("warns once the dead-letter queue passes its warning threshold", () => {
    const alert = alertDecision(stats({ deadLetter: { size: 10, warnThreshold: 10, failThreshold: 50 } }));

    expect(alert?.level).toBe("warn");
    expect(alert?.headline).toContain("10");
  });

  it("does not warn just below the threshold", () => {
    const alert = alertDecision(stats({ deadLetter: { size: 9, warnThreshold: 10, failThreshold: 50 } }));

    expect(alert).toBeNull();
  });

  it("warns about a backlog that is mostly delayed", () => {
    const alert = alertDecision(stats({ depth: { total: 400, delayed: 380 } }));

    // Delayed-heavy means quiet hours or a spent quota, which resolve on their
    // own. Worth a mention, not a page.
    expect(alert?.level).toBe("warn");
    expect(alert?.headline).toContain("delayed");
  });

  it("stays quiet about a small delayed backlog", () => {
    // Below 100 the ratio is noise from a handful of scheduled reminders.
    expect(alertDecision(stats({ depth: { total: 40, delayed: 38 } }))).toBeNull();
  });

  it("stays quiet about a mostly-waiting backlog, which is a different fault", () => {
    // All waiting and nothing delayed means no worker, not a scheduling quirk.
    // The runbook covers that; the alert should not cry wolf about it.
    expect(alertDecision(stats({ depth: { total: 400, delayed: 0 } }))).toBeNull();
  });
});

describe("webhookBody", () => {
  it("includes a readable line and the numbers behind it", () => {
    const source = stats({ deadLetter: { size: 12, warnThreshold: 10, failThreshold: 50 } });
    const body = webhookBody(alertDecision(source)!, source);

    // `text` is what Slack and Discord both render, so it has to stand alone -
    // a chat message that says "see the logs" and nothing else is not an alert.
    expect(body.text).toContain("12");
    expect(body.alert.level).toBe("warn");
    expect(body.stats.deadLetter.size).toBe(12);
  });
});