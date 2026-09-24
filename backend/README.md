# NotifyHub backend

Express API, BullMQ workers and the Prisma schema.

## First run

```bash
cd backend
npm install
```

Make sure `DATABASE_URL` in your `.env` points at a Postgres you can reach —
the local Docker one from `docker-compose.yml`, or your Neon connection string:

```
DATABASE_URL=postgresql://notifyhub:notifyhub@localhost:5432/notifyhub
```

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
