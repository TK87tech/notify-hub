/**
 * Deciding whether to shout, kept apart from the shouting.
 *
 * The thresholds deliberately live in one place: the payload this reads already
 * carries a `status` of ok, degraded or failing, computed in
 * src/api/operations.ts. Re-deriving "is this bad enough" here would give the
 * dashboard and the alert two definitions that drift apart, and the alert is the
 * one nobody looks at until it is wrong.
 */

export interface QueueStatsLike {
  status: "ok" | "degraded" | "failing";
  redis: { reachable: boolean };
  deadLetter: { size: number; warnThreshold: number; failThreshold: number };
  depth: { total: number; delayed: number };
}

export interface Alert {
  level: "warn" | "critical";
  /** One line. Suitable as a subject or a chat message. */
  headline: string;
  /** What to do next, or where to look. */
  detail: string;
}

/**
 * Returns null when there is nothing worth interrupting somebody for.
 *
 * Redis first, because it explains every other number: a worker that cannot
 * reach Redis cannot pick anything up, so a growing backlog underneath a dead
 * Redis is one fault, not two.
 */
export function alertDecision(stats: QueueStatsLike): Alert | null {
  if (!stats.redis.reachable) {
    return {
      level: "critical",
      headline: "NotifyHub cannot reach Redis",
      detail:
        "Nothing can be queued or delivered. The worker and the API are both " +
        "blind. Check REDIS_URL and the provider's status page first.",
    };
  }

  if (stats.status === "failing") {
    return {
      level: "critical",
      headline: `NotifyHub is failing: ${stats.deadLetter.size} dead-lettered`,
      detail:
        "See docs/RUNBOOK.md. If the provider has recovered, requeue the " +
        "dead letters rather than clearing them.",
    };
  }

  if (stats.deadLetter.size >= stats.deadLetter.warnThreshold) {
    return {
      level: "warn",
      headline: `${stats.deadLetter.size} dead-lettered deliveries`,
      detail:
        `Past the warning threshold of ${stats.deadLetter.warnThreshold}. ` +
        "Not urgent, but it will not drain itself.",
    };
  }

  if (stats.depth.delayed > stats.depth.total / 2 && stats.depth.total > 100) {
    return {
      level: "warn",
      headline: `${stats.depth.delayed} of ${stats.depth.total} jobs are delayed`,
      detail:
        "Mostly delayed rather than waiting usually means quiet hours or a " +
        "spent email quota. Both resolve on their own.",
    };
  }

  return null;
}

/** The payload posted to the webhook. Generic enough for Slack or Discord. */
export function webhookBody(alert: Alert, stats: QueueStatsLike) {
  return {
    text: `${alert.level === "critical" ? ":rotating_light:" : ":warning:"} ${alert.headline}\n${alert.detail}`,
    alert: {
      level: alert.level,
      headline: alert.headline,
      detail: alert.detail,
    },
    stats: {
      status: stats.status,
      deadLetter: stats.deadLetter,
      depth: stats.depth,
    },
  };
}