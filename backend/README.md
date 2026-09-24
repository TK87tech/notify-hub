# NotifyHub backend

Express API, BullMQ workers and the Prisma schema.

## First run

```bash
cd backend
npm install
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
```

**The `.env` must be in `backend/`, not the project root.** Prisma reads it
from the folder you run the command in, so a root-level `.env` is not found
and you get `Environment variable not found: DATABASE_URL`.

Start Postgres before migrating — from the **project root**:

```bash
docker compose up -d
```

No Docker? Create a free database at neon.tech and paste its connection string
into `backend/.env` instead, keeping `?sslmode=require` on the end.

Then create the tables and fill them with test data:

```bash
npm run db:migrate    # creates the migration and applies it
npm run db:seed       # two users, six notifications, delivery attempts
```

`npm run db:studio` opens a browser view of the data, which is the quickest way
to check a change did what you expected.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with hot reload on :4000 |
| `npm run worker` | Queue worker, as its own process |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply existing migrations (used on deploy) |
| `npm run db:seed` | Reset seed data |
| `npm run db:reset` | Drop everything, re-migrate, re-seed |
| `npm run db:studio` | Browse the data |

## Running the API

The API reads `backend/.env` through `dotenv`, loaded at the top of
`src/config/env.ts`. Every variable is validated on boot, so a missing
`JWT_SECRET` stops the server with a clear message instead of failing on the
first request. If you see "Invalid environment configuration", your `.env` is
missing one of the values in `.env.example`.

```bash
npm run dev            # http://localhost:4000, reloads on save
npm test               # 13 tests, no database needed
npm run typecheck      # tsc --noEmit
```

### The two front doors

| Route prefix | Guard | Who calls it |
|---|---|---|
| `/health`, `/health/ready` | none | Render, monitoring, you |
| `/api/v1/*` | `requireUser` - JWT in `Authorization: Bearer <token>` | the browser |
| `/internal/*` | `requireService` - shared secret in `x-service-key` | our own services |

The producer endpoint lives under `/internal` on purpose. If a browser could
reach it, any user could send notifications to anyone.

### Getting a token before sign-in exists

```bash
npm run token                          # first seeded user
npm run token -- ada@notifyhub.test    # a specific one
```

It prints a ready-made curl command. Try it:

```bash
curl http://localhost:4000/health
curl -H "Authorization: Bearer <token>" http://localhost:4000/api/v1/me
curl -H "x-service-key: <SERVICE_KEY from .env>" http://localhost:4000/internal/ping
```

### Errors

Never write an error response by hand. Throw one of the helpers from
`src/lib/errors.ts` and the error handler turns it into the contract's shape:

```ts
import { notFound, badRequest } from "../lib/errors.js";

const n = await prisma.notification.findUnique({ where: { id } });
if (!n) throw notFound("Notification not found");
```

Express 5 forwards rejected promises on its own, so an async handler needs no
try/catch for this to work.

## The schema

Five tables plus one guard table:

| Table | Holds |
|---|---|
| `users` | People who receive notifications |
| `notifications` | One row per notification, with read state |
| `preferences` | Per-user channel choices and quiet hours |
| `devices` | Push tokens, one row per device |
| `delivery_attempts` | One row per attempt per channel — how a failure gets explained later |
| `idempotency_keys` | Stops the same notification being sent twice |

Two indexes carry the whole read path: `(userId, createdAt DESC)` for the
notification list, and `(userId, read)` for the unread badge. Don't remove them.

`preferences.channels` is JSON rather than a table, so adding a sixth
notification type later needs no migration. The shape matches
`Preferences.channels` in `contracts/openapi.yaml` exactly.

## Rules for this folder

- **Only Bell runs migrations.** If you need a schema change, ask in the pull
  request rather than adding a migration of your own — two people generating
  migrations against the same database gets messy quickly.
- Enum values here mirror `contracts/openapi.yaml`. Changing one means changing
  both, in the same pull request.
- `delivery_attempts` is append-only. Never update a row; write a new attempt.
