# Bell decisions and contract baseline

This document records the team-approved Bell decisions for the notification system. It is the reference the backend and frontend use before moving into the end-to-end integration stage.

## Notification types

The team approved these five notification types:

- task_assigned
- payment_received
- deadline_warning
- comment
- system

These values match the enum in the API contract and the Prisma schema.

## Channel defaults

These are the agreed default delivery preferences for each notification type:

| Notification type | inApp | email | push |
|---|---:|---:|---:|
| task_assigned | true | true | false |
| payment_received | true | true | true |
| deadline_warning | true | false | true |
| comment | true | false | false |
| system | true | true | false |

## Priority model

The agreed priority levels are:

- urgent — requires immediate attention; it should skip normal queue pacing and not auto-dismiss in the UI toaster.
- normal — standard delivery, default for most notifications.
- low — informational or non-urgent; it may be delayed by quiet hours.

## Quiet hours rule

Low-priority notifications may be delayed during quiet hours. Urgent notifications should still pass through even when quiet hours are active.

## Contract status

The API contract in [contracts/openapi.yaml](../contracts/openapi.yaml) and the realtime contract in [contracts/realtime-events.md](../contracts/realtime-events.md) are now the shared source of truth. Any change after this point must be handled through a pull request with backend and frontend approval.

## Follow-up for integration

The next Bell step is to swap the mock server for the real backend and fix any contract mismatches revealed during the full-flow demo.
