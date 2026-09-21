# The stack, and why each piece is free

Everything below has a free tier that needs no card, or runs locally on your own
machine. Where a card is needed, it is noted plainly.

## The choices

| Layer | Choice | Free? | Why this one |
|---|---|---|---|
| Backend runtime | **Node.js + Express** | Free, open source | The team already writes JavaScript on the frontend, so one language across the stack. |
| Queue | **BullMQ on Redis** | Free, open source | Retries, backoff, delayed jobs, priorities and a dead-letter queue come built in. RabbitMQ and Kafka are heavier than a five-person project needs. |
| Redis host | **Local Docker** for development, **Upstash** free tier when deployed | Free, no card | Upstash gives 10,000 commands a day, which is far beyond a student project. |
| Database | **PostgreSQL** via **Neon** free tier | Free, no card | 0.5 GB storage, branches per developer. Supabase is an equally good alternative. |
| ORM | **Prisma** | Free, open source | Migrations are version-controlled, so five people stay on the same schema. |
| Realtime | **Socket.IO** | Free, open source | Reconnects on its own and has rooms, so delivering to one user is one line. |
| Frontend | **React + Vite** | Free, open source | Fast dev server, and the whole team can learn it quickly. |
| Frontend styling | **Tailwind CSS** | Free, open source | What the template is built on. |
| UI components | **shadcn/ui** | Free, MIT | Copies component source into our repo, so we own and can edit every component. See `docs/UI-TEMPLATE.md`. |
| App shell | **TailAdmin free React dashboard** | Free, MIT | Sidebar and responsive layout, stripped to what we need. |
| Toasts | **Sonner** (comes with shadcn/ui) | Free, MIT | Stacking, auto-dismiss and swipe already solved. |
| Mock API | **Prism** (Stoplight) | Free, open source | Serves a live fake API straight from `openapi.yaml`, so frontend never waits for backend. |
| Email | **Brevo** free tier | Free, 300 emails/day, no card | Generous daily limit. Resend (3,000/month) is the alternative. |
| Push | **Firebase Cloud Messaging** | Free, unlimited | The only genuinely free push option for web and mobile. |
| SMS | **Deliberately left out** | — | There is no free SMS provider. Twilio gives trial credit only. We build the adapter interface so SMS can be added later, but we do not ship it. |
| API hosting | **Render** free web service | Free, no card | Sleeps after 15 minutes idle and takes ~30s to wake. Fine for a demo. |
| Frontend hosting | **Vercel** or **Netlify** free tier | Free, no card | Deploys from `main` automatically. |
| CI | **GitHub Actions** | Free, 2,000 minutes/month on private repos, unlimited on public | Runs tests on every pull request. |
| Planning | **GitHub Projects** | Free | Already where the code is. |
| Design | **None — we use a template** | Free | No designer on the team. `docs/UI-TEMPLATE.md` explains the choice. |
| Error monitoring | **Sentry** free tier | Free, 5,000 events/month | Optional, but worth adding in Stage 10. |

## One honest caution

Render's free tier sleeps. The WebSocket connection drops when it does, so the
first person to open the app after a quiet period waits about 30 seconds and the
live toast will not arrive until the service wakes. For your demo, open the app
a minute before you present. If that matters more later, Fly.io's free allowance
does not sleep the same way.

## Local development

Everything runs on one machine with Docker:

```bash
docker compose up -d     # Postgres + Redis
cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

If someone on the team cannot run Docker, they can point `DATABASE_URL` and
`REDIS_URL` at the free Neon and Upstash instances instead. The code does not care.

## Frontend before backend exists

From day one, Pulse and Beacon can run:

```bash
npx @stoplight/prism-cli mock contracts/openapi.yaml --port 4010
```

That serves every endpoint in the contract with realistic fake data. Set
`VITE_API_URL=http://localhost:4010` and build the entire interface before a
single backend endpoint is written.
