/**
 * The dead-letter alert (issue #33).
 *
 * Run this from a scheduler every five minutes. It reads the same
 * /internal/queue-stats the dashboard reads, so the alert and the dashboard can
 * never disagree about how bad things are.
 *
 * Two ways to be notified, and you only need one:
 *
 *   ALERT_WEBHOOK_URL   A Slack or Discord incoming webhook. Gets a JSON body.
 *   exit code          1 when critical, 0 otherwise, so a bare scheduler with
 *                       no webhook can still page somebody by watching for a
 *                       non-zero exit.
 *
 * Usage:
 *   npm run alert
 *   API_URL=https://... SERVICE_KEY=... npm run alert
 */

import { alertDecision, webhookBody, type QueueStatsLike } from "../src/lib/alert.js";

// Same default as env.PORT, so running this against a local `npm run dev`
// needs no configuration. In production API_URL is the deploy's public URL.
const apiUrl = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(
  /\/$/,
  "",
);
const serviceKey = process.env.ALERT_SERVICE_KEY ?? process.env.SERVICE_KEY;
const webhookUrl = process.env.ALERT_WEBHOOK_URL;

/**
 * A ceiling on every request this script makes.
 *
 * The failure mode to avoid is the quiet one: if the API is wedged, a bare
 * fetch waits forever, the scheduler never sees an exit code, and the alert
 * silently stops running - discovered only once deliveries have been broken for
 * a while. Hanging and saying nothing is the worst possible behaviour for the
 * thing whose job is to speak up.
 */
const TIMEOUT_MS = 10_000;

async function main() {
  if (!serviceKey) {
    // Not fatal. A scheduler that only watches the exit code still works, and
    // the endpoint needs the key.
    console.warn("SERVICE_KEY is not set; /internal/queue-stats will be rejected.");
  }

  const response = await fetch(`${apiUrl}/internal/queue-stats`, {
    headers: serviceKey ? { "x-service-key": serviceKey } : {},
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // A failing check is itself worth reporting: silence here is indistinguishable
    // from a healthy system.
    console.error(`queue-stats returned ${response.status} ${response.statusText}`);
    process.exitCode = 2;
    return;
  }

  const stats = (await response.json()) as QueueStatsLike;
  const alert = alertDecision(stats);

  if (!alert) {
    console.log(
      `ok - ${stats.depth.total} queued, ${stats.deadLetter.size} dead-lettered`,
    );
    return;
  }

  console.error(`${alert.level.toUpperCase()}: ${alert.headline}\n${alert.detail}`);

  if (webhookUrl) {
    const posted = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhookBody(alert, stats)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!posted.ok) {
      console.error(`webhook returned ${posted.status} ${posted.statusText}`);
    }
  }

  // Set the code and let Node exit on its own rather than calling process.exit().
  // Forcing the exit while sockets are still closing trips a libuv assertion on
  // Windows, which replaces the intended exit code with a crash status - so a
  // scheduler watching for "exit 1 means critical" would never see the alert.
  process.exitCode = alert.level === "critical" ? 1 : 0;
}

main().catch((err) => {
  console.error("alert check failed:", err instanceof Error ? err.message : err);
  process.exitCode = 2;
});