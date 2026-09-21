# The team

Seven developers. No separate designer — we build on an existing free template
(see [`docs/UI-TEMPLATE.md`](UI-TEMPLATE.md)), and **Prism** owns keeping the
interface consistent as a frontend development job, not a design job.

The code name is what we use in branch names, labels and CODEOWNERS, so the
repository reads the same way whoever is looking.

| Code name | Role | Owns | Label |
|---|---|---|---|
| **Bell** | Backend lead, team coordinator | Database schema, producer API, read endpoints, auth, the API contract | `owner:bell` |
| **Relay** | Backend, queue engine | BullMQ queue, workers, retries, dead-letter queue, Socket.IO gateway | `owner:relay` |
| **Ember** | Backend, delivery channels | Email and push adapters, message templates, preferences API, quiet hours | `owner:ember` |
| **Pulse** | Frontend, live surface | Bell icon, notification panel, toasts, Socket.IO client | `owner:pulse` |
| **Beacon** | Frontend, settings surface | Preferences page, device registration, forms | `owner:beacon` |
| **Prism** | Frontend, shell and shared UI | Template setup, theming, shared components, routing, responsive and accessibility | `owner:prism` |
| **Warden** | DevOps and QA | CI/CD, deployments, environment secrets, monitoring, load and failure testing | `owner:warden` |

## Why this split works

Three people in `/backend`, but never in the same files:

- **Bell** owns everything that writes to the database and answers HTTP.
- **Relay** owns everything that reads from the queue.
- **Ember** owns everything that talks to an outside provider.

They meet only at contracts — the queue job shape and the `Channel` interface —
not at shared source files.

Three people in `/frontend`, in separate folders:

- **Prism** in `src/app` and `src/components` — the shell and anything shared.
- **Pulse** in `src/features/notifications`.
- **Beacon** in `src/features/preferences`.

Prism goes first. Nobody else can build screens until the template is installed
and the shared components exist, so Prism's Stage 2 work is the only thing on
the critical path in week one.

**Warden** touches almost no application code, which is exactly why a seventh
person is useful rather than crowded. Warden owns `.github/`, the deploy
configuration and the test infrastructure — files the other six rarely open.

## Who reviews whose work

| Author | First reviewer | Second, if it changes the interface |
|---|---|---|
| Bell | Relay | — |
| Relay | Ember | — |
| Ember | Bell | — |
| Pulse | Beacon | Prism |
| Beacon | Pulse | Prism |
| Prism | Pulse or Beacon | — |
| Warden | Bell | — |

One approval merges. A second reviewer is requested automatically by CODEOWNERS
when a pull request touches shared frontend components.

## The one weekly ritual

A 30-minute call every Monday. Three questions each: what you merged, what you
are on, what is blocking you. Move your board cards before the call, not during it.

With seven people this call is the only thing standing between you and two
people quietly building the same component. Nobody skips it.
