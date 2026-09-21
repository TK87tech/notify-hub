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

## Documentation

- [`docs/WINDOWS-SETUP.md`](docs/WINDOWS-SETUP.md) — installing Git, GitHub CLI and Node on Windows
- [`docs/TEAM.md`](docs/TEAM.md) — who owns what
- [`docs/BRANCHING.md`](docs/BRANCHING.md) — branches, commits, pull requests
- [`docs/UI-TEMPLATE.md`](docs/UI-TEMPLATE.md) — the free UI template and how to install it
- [`docs/STACK.md`](docs/STACK.md) — every tool chosen and why it is free
- [`contracts/openapi.yaml`](contracts/openapi.yaml) — REST API contract
- [`contracts/realtime-events.md`](contracts/realtime-events.md) — Socket.IO events
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute

## Status

Stage tracking lives on the GitHub Project board. Milestones map to the phases:
Plan (stages 1–3), Build (4–7), Launch (8–11).
