/**
 * Load test for the delivery pipeline (issue #28). `npm run load-test`.
 *
 * Posts N notifications to a running API through the real producer endpoint,
 * then watches delivery_attempts until every (notification, channel) pair has
 * a final outcome - sent or dead - or nothing has moved for --idle seconds.
 *
 * It reports what matters for "nothing is lost": pairs expected vs. settled,
 * pairs that never settled (lost), pairs sent more than once (duplicates),
 * retries, dead letters, throughput and end-to-end latency.
 *
 * Everything goes to one dedicated user, loadtest@notifyhub.test, whose
 * notifications are deleted at the start of each run. Run it against a local
 * stack (docker compose + `npm run start` + `npm run start:worker`), not
 * production: 1,000 notifications cost real Brevo and Upstash quota.
 *
 *   npm run load-test -- --count 1000 --type comment
 *   npm run load-test -- --count 20 --type system      (in-app + email)
 *
 * Failure scenarios are driven by hand while it runs - kill the worker, restart
 * Redis, point the worker at a dead proxy - and the report says whether the
 * pipeline recovered. See the results on issue #28.
 */

import { randomUUID } from "node:crypto";

import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const COUNT = Number(arg("count", "1000"));
const TYPE = arg("type", "comment");
const CONCURRENCY = Number(arg("concurrency", "50"));
const API = arg("api", `http://localhost:${env.PORT}`);
const IDLE_SECONDS = Number(arg("idle", "180"));

/** Default channels per type (docs/BELL-DECISIONS.md); the test user has no preference row. */
const DEFAULT_CHANNELS: Record<string, number> = {
  task_assigned: 2,
  payment_received: 3,
  deadline_warning: 2,
  comment: 1,
  system: 2,
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const runId = randomUUID().slice(0, 8);
  const user = await prisma.user.upsert({
    where: { email: "loadtest@notifyhub.test" },
    update: {},
    create: { email: "loadtest@notifyhub.test", name: "Load test" },
  });

  await prisma.notification.deleteMany({ where: { userId: user.id } });

  console.log(`run ${runId}: ${COUNT} x ${TYPE} -> ${API}, ${CONCURRENCY} at a time`);

  // --- produce -----------------------------------------------------------
  const outcomes: Record<string, number> = {};
  let next = 0;
  const producedAt = Date.now();

  async function producer() {
    while (next < COUNT) {
      const i = next++;
      let status = "error";

      try {
        const res = await fetch(`${API}/internal/notifications`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-service-key": env.SERVICE_KEY },
          body: JSON.stringify({
            userId: user.id,
            type: TYPE,
            title: `Load test ${runId} #${i}`,
            idempotencyKey: `load-${runId}-${i}`,
          }),
        });
        status = res.ok ? ((await res.json()) as { status: string }).status : `http_${res.status}`;
      } catch {
        status = "network_error";
      }

      outcomes[status] = (outcomes[status] ?? 0) + 1;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, producer));

  const produceMs = Date.now() - producedAt;
  const accepted = (outcomes.queued ?? 0) + (outcomes.delayed ?? 0);
  const expectedPairs = accepted * (DEFAULT_CHANNELS[TYPE] ?? 1);

  console.log(`produced in ${produceMs} ms:`, outcomes);

  // --- watch it drain ------------------------------------------------------
  type Progress = { settled: number; sent: number; dead: number; failed: number; duplicates: number };

  const progress = async (): Promise<Progress> => {
    const [row] = await prisma.$queryRaw<Progress[]>`
      WITH pairs AS (
        SELECT a."notificationId", a.channel,
               count(*) FILTER (WHERE a.status = 'sent')   AS sent,
               count(*) FILTER (WHERE a.status = 'dead')   AS dead,
               count(*) FILTER (WHERE a.status = 'failed') AS failed
        FROM delivery_attempts a
        JOIN notifications n ON n.id = a."notificationId"
        WHERE n."userId" = ${user.id}
        GROUP BY 1, 2
      )
      SELECT count(*) FILTER (WHERE sent > 0 OR dead > 0)::int AS settled,
             count(*) FILTER (WHERE sent > 0)::int             AS sent,
             count(*) FILTER (WHERE dead > 0)::int             AS dead,
             coalesce(sum(failed), 0)::int                     AS failed,
             count(*) FILTER (WHERE sent > 1)::int             AS duplicates
      FROM pairs`;
    return row;
  };

  let last = await progress();
  let lastChange = Date.now();

  while (last.settled < expectedPairs && Date.now() - lastChange < IDLE_SECONDS * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const now = await progress();

    if (now.settled !== last.settled || now.failed !== last.failed) {
      lastChange = Date.now();
      console.log(
        `  +${Math.round((Date.now() - producedAt) / 1000)}s  settled ${now.settled}/${expectedPairs}` +
          `  sent ${now.sent}  dead ${now.dead}  retries ${now.failed}`,
      );
    }
    last = now;
  }

  // --- report --------------------------------------------------------------
  const latencies = (
    await prisma.$queryRaw<{ ms: number }[]>`
      SELECT EXTRACT(EPOCH FROM (min(a."createdAt") - n."createdAt")) * 1000 AS ms
      FROM delivery_attempts a
      JOIN notifications n ON n.id = a."notificationId"
      WHERE n."userId" = ${user.id} AND a.status = 'sent'
      GROUP BY a."notificationId", a.channel, n."createdAt"`
  )
    .map((row) => Number(row.ms))
    .sort((a, b) => a - b);

  const [{ last_at: lastAt }] = await prisma.$queryRaw<{ last_at: Date | null }[]>`
    SELECT max(a."createdAt") AS last_at FROM delivery_attempts a
    JOIN notifications n ON n.id = a."notificationId" WHERE n."userId" = ${user.id}`;
  const drainMs = lastAt ? lastAt.getTime() - producedAt : null;

  const report = {
    runId,
    type: TYPE,
    requested: COUNT,
    accepted,
    producerOutcomes: outcomes,
    produceMs,
    expectedPairs,
    settledPairs: last.settled,
    sentPairs: last.sent,
    deadPairs: last.dead,
    lostPairs: expectedPairs - last.settled,
    duplicatePairs: last.duplicates,
    retries: last.failed,
    drainMs,
    throughputPerSec: drainMs ? Number((last.settled / (drainMs / 1000)).toFixed(1)) : null,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.at(-1) ?? null,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(report.lostPairs === 0 && report.duplicatePairs === 0 ? 0 : 1);
}

void main();
