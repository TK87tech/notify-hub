# NotifyHub

A notification queue system: one event in, delivered to the right people on the
right channels, reliably.

Built by seven people in parallel. Start with [`docs/TEAM.md`](docs/TEAM.md) to find
your code name, then [`docs/BRANCHING.md`](docs/BRANCHING.md) for the daily loop.

## What it does

```
event happens  →  producer API  →  queue  →  workers  →  channel adapters  →  user
                                     ↓                        ├─ in-app (Socket.IO)
                              retries, backoff,               ├─ email (Brevo)
                              dead-letter queue               └─ push (FCM)
```

## Repository layout

```
contracts/     The API contract. The single source of truth both sides build against.
backend/       Express API, BullMQ workers, Prisma schema.
frontend/      React + Vite app.

docs/          Team, branching, stack decisions.
scripts/       One-time GitHub setup.
```

## Getting started

```bash
git clone https://github.com/<owner>/notify-hub.git
cd notify-hub
cp .env.example .env
docker compose up -d          # Postgres + Redis locally

cd backend  && npm install && npm run dev     # http://localhost:4000
cd frontend && npm install && npm run dev     # http://localhost:5173
```

Frontend developers who want to work before the backend is ready:

```bash
npx @stoplight/prism-cli mock contracts/openapi.yaml --port 4010
# then set VITE_API_URL=http://localhost:4010 in frontend/.env
```

## Deployment

Free tier throughout: API and worker on Render ([`render.yaml`](render.yaml)),
frontend on Vercel ([`frontend/vercel.json`](frontend/vercel.json)), Postgres on
Neon, Redis on Upstash. The accounts and keys come from issue #7.

**Backend (Render)**

1. Render → New → Blueprint → this repo. It creates `notifyhub-api`,
   `notifyhub-worker` and the shared env group `notifyhub-shared`.
2. Fill in the values it asks for. `JWT_SECRET` and `SERVICE_KEY` are generated
   for you. `REDIS_URL` is Upstash's `rediss://` (TLS) URL; `DATABASE_URL` is
   Neon's string with `?sslmode=require`.
3. Once the worker has a URL, set the API's `WORKER_WAKE_URL` to
   `https://<worker>.onrender.com/health` and redeploy the API.
4. Migrations run automatically every time the API starts (`prisma migrate deploy`).

**Frontend (Vercel)**

1. Import the repo and set **Root Directory** to `frontend`. Everything else is
   in `vercel.json`. Deploys from `main` automatically.
2. Environment variables: `VITE_API_URL=https://<api>.onrender.com/api/v1`, plus
   `VITE_VAPID_PUBLIC_KEY` and the four `VITE_FIREBASE_*` values for push (see
   [`frontend/.env.example`](frontend/.env.example)).
3. Put the Vercel URL in the API's `APP_URL`. It is the allowed origin for both
   CORS and Socket.IO; extra origins (preview URLs, a custom domain) go in
   `CORS_ORIGINS`, comma-separated.

### Free-tier sleep: read this before the demo

- **Both Render services sleep after 15 minutes without HTTP traffic** and take
  about 30 seconds to wake. The first page load after a quiet spell is slow,
  and the frontend's 45-second request timeout is sized for exactly that.
- **A sleeping worker delivers nothing.** Jobs wait safely in Redis. The API
  wakes the worker whenever it queues a job, so a new notification arrives
  roughly 30 seconds late after a quiet period, then promptly after that.
- **Delayed jobs can be late.** A notification held by quiet hours or the daily
  email limit goes out when the worker next wakes, not at the exact minute.
- **The live socket drops when the API sleeps.** The app reconnects and refetches
  on its own.
- **Free hours are shared.** Render gives 750 instance hours a month across the
  workspace. Two services that sleep when idle fit comfortably; two kept awake
  around the clock (for example by an uptime pinger) do not.

Before presenting: open the app and send one test notification a couple of
minutes early. That wakes the API and the worker together.

## Documentation

- [`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md) — installing Git, GitHub CLI and Node on Windows
- [`docs/TEAM.md`](docs/TEAM.md) — who owns what
- [`docs/BRANCHING.md`](docs/BRANCHING.md) — branches, commits, pull requests
- [`docs/UI-TEMPLATE.md`](docs/UI-TEMPLATE.md) — the free UI template and how to install it
- [`docs/STACK.md`](docs/STACK.md) — every tool chosen and why it is free
- [`docs/BELL-DECISIONS.md`](docs/BELL-DECISIONS.md) — Bell-approved notification decisions, defaults and contract baseline
- [`contracts/openapi.yaml`](contracts/openapi.yaml) — REST API contract
- [`contracts/realtime-events.md`](contracts/realtime-events.md) — Socket.IO events
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute

## Status

Stage tracking lives on the GitHub Project board. Milestones map to the phases:
Plan (stages 1–3), Build (4–7), Launch (8–11).
