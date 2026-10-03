# Runbook: notifications stopped arriving

Written for one person on a free tier with no on-call rotation. Everything here
assumes you have the API URL and `SERVICE_KEY` from the deploy's environment.

The shortest possible version:

```bash
curl -s "$API/health/ready" | jq
curl -s -H "x-service-key: $SERVICE_KEY" "$API/internal/queue-stats" | jq '{status, depth, deadLetter, processing}'
```

`status` is `ok` and `depth.total` is near zero, but nobody received anything?
Skip to [Nothing is wrong and it still did not arrive](#nothing-is-wrong-and-it-still-did-not-arrive).

## The three queues

| Queue | Holds | If it is growing |
| --- | --- | --- |
| `notifications` | in-app and push | The worker is down, slow, or Redis is gone |
| `notifications.email` | email only | Brevo is failing, or the daily quota is spent |
| `notifications.dlq` | gave up after 5 attempts | Read the entries; do not just clear them |

Email is on its own queue so a Brevo outage cannot delay a push. The cost is
that email-only problems look identical to a dead worker unless you check which
queue is deep.

## Check in this order

**1. Is the process up?**

`GET /health` answers without touching Postgres or Redis. If it does not answer
at all, the web service is down or mid-deploy and nothing below matters.
`GET /health/ready` pings both dependencies and returns 503 when either fails.

It can take up to two seconds to answer 503, by design. Redis commands elsewhere
in this system are built to wait out a reconnect rather than fail, because a
delivery job should survive a blip - but a health check that waits is useless,
since the outage it exists to report is the outage that makes it wait. The probe
client is the deliberate exception, with a hard two second deadline.

**2. Did Redis go away?**

`queue-stats` reports `redis.reachable`. When it is false, `status` is forced to
`failing` regardless of any other number. A worker with no Redis cannot pick
anything up, so a growing `waiting` count here is a symptom, not the cause.

**3. Is the worker actually running?**

`depth.active` of zero while `depth.waiting` climbs means no worker is
consuming. The API and the worker are separate processes on Render and are
deployed independently, so a green API says nothing about the worker. Restart the
worker service and watch `active` become non-zero.

**4. Which queue is deep?**

`queues.notifications` deep means in-app or push. `queues.email` deep means
Brevo or the quota. If only `delayed` is deep, nothing is broken - see
[Nothing is wrong](#nothing-is-wrong-and-it-still-did-not-arrive).

**5. What failed?**

```bash
curl -s -H "x-service-key: $SERVICE_KEY" \
  "$API/internal/dead-letters?limit=20" | jq '.items[] | {channel, reason, error, permanent}'
```

Read `reason` first and `error` second. `error` is the provider's own wording and
is usually the most specific thing on the page. These are the only six reasons
the worker writes.

| `reason` | `permanent` | Meaning | Do this |
| --- | --- | --- | --- |
| `retries exhausted` | false | The provider failed all 5 attempts, 2s/4s/8s/16s apart | Look at `error`. If the provider is healthy now, requeue |
| `permanent failure` | true | The provider said this will never work | Fix the data, then requeue. Retrying unchanged just refills this queue |
| `notification row is missing` | true | The notification was deleted before delivery | Nothing to do. Usually a deleted user |
| `recipient no longer exists` | true | The user row is gone | Nothing to do |
| `user mismatch` | true | The job names a user who does not own the notification | A real bug. The worker refused to deliver it to the wrong person |
| `unexpected error` | false | A channel threw something that was not a known failure | A bug. `error` has the stack message |

`permanent: true` is the field that saves time. A bad address or a revoked push
token will fail identically on every retry, so a requeue without fixing the
cause just fills the dead-letter queue again.

One thing that looks like a failure but is not: hitting the daily email ceiling
does **not** dead-letter. The job is parked until UTC midnight and delivered
afterwards, so a quota problem shows up as a growing `delayed` count and never
appears in this list.

## Requeue after a provider outage

Once the provider is healthy again:

```bash
curl -s -X POST -H "x-service-key: $SERVICE_KEY" \
  "$API/internal/dead-letters/requeue?id=<job id>" | jq
```

This puts the delivery back on its channel's queue with a fresh set of five
attempts and removes the dead-letter entry. Requeue everything at once after a
Brevo outage will hit the 300/day ceiling partway through, so loop with a short
sleep and watch `emailQuota.used`.

## Nothing is wrong and it still did not arrive

Three things look like an outage and are not:

**Quiet hours.** Each user sets their own window and timezone in preferences.
Outside it, only **`low` priority** waits; `urgent` and `normal` are always
delivered immediately. A low-priority job held this way sits on the `delayed`
list and goes out at the end of the window. If `depth.delayed` is the only
number climbing and `urgent` notifications are arriving, nothing is broken.

**Preferences.** A notification with every channel switched off is never queued
at all. The producer returns `suppressed`. It is not in any queue, because
there was never a job.

**The daily email quota.** One shared Brevo account sends 300 emails a day, and
Neon and Upstash free tiers count the same way, so the ceiling is real and low.
Past it, email jobs sit delayed until UTC midnight. `emailQuota.used` and
`emailQuota.resetsAtUtc` are in the same payload.

## The alert

`npm run alert` in `backend/` reads the same `/internal/queue-stats` this page
does, so the alert and the dashboard can never disagree about how bad things
are. Run it from a scheduler every five minutes.

```bash
API_URL=https://... SERVICE_KEY=... ALERT_WEBHOOK_URL=https://hooks.slack.com/... npm run alert
```

`ALERT_WEBHOOK_URL` is optional. The exit code is the reliable channel:

| Exit | Meaning |
| --- | --- |
| 0 | Healthy, or a warning that is not worth waking anyone for |
| 1 | Critical. Redis is unreachable, or the system is failing |
| 2 | The check itself failed - wrong URL, bad key, or no response in 10s |

Exit 2 matters as much as exit 1. A check that cannot reach the API is
indistinguishable from a healthy system if nobody looks at the code, and that is
how monitoring quietly stops working.

Every request it makes has a 10 second ceiling. A check that hangs is worse than
one that fails, because a scheduler waiting on a dead process reports nothing at
all - and this is the thing whose whole job is to speak up.

## Thresholds

`status` is computed in `backend/src/api/operations.ts` and is worth reading
before trusting it.

| Condition | Result |
| --- | --- |
| Redis unreachable | `failing` |
| `deadLetter.size >= 50` (`DLQ_FAIL_THRESHOLD`) | `failing` |
| Failure rate `> 0.25` | `failing` |
| `deadLetter.size >= 10` (`DLQ_WARN_THRESHOLD`) | `degraded` |
| Failure rate `> 0.1` | `degraded` |
| `depth.total > 500` | `degraded` |

Both thresholds are strict, so a failure rate of exactly 0.25 is `degraded`.
The dead-letter queue is reported separately and never counted as backlog,
because it is only drained by hand and a full DLQ is not a queue that is
growing.

`processing.p95Ms` is producer-to-provider time for successful deliveries in the
last 24 hours, and `processing.p50Ms` is the same for the healthy path. A p95
many times the median means retries are stretching the tail, which is the
failure rate showing up as latency. Both are `null` until something has been
delivered.

## If Redis is empty and there is no backlog

Nothing was ever queued. Check the producer's response: `suppressed` means
preferences, `duplicate` means the idempotency key was reused, and `202` with a
`deliverAt` in the future means it is scheduled and the delay is not yet due.