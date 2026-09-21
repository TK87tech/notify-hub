# Realtime contract (Socket.IO)

The REST API in `openapi.yaml` covers everything the browser asks for.
This file covers what the server pushes without being asked.

We use **Socket.IO** (free, open source) rather than raw WebSocket, because it
reconnects on its own, falls back to long-polling on poor networks, and gives us
rooms — which is exactly how we deliver to one user.

- Local URL: `ws://localhost:4000`
- Path: `/socket.io` (the default)
- Every user joins a room named `user:<userId>` on connect.

## Connecting

The client sends its JWT in the handshake:

```js
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_API_URL, {
  auth: { token: accessToken },
  transports: ["websocket", "polling"],
});
```

The server verifies the token in middleware. If it fails, the server emits
`connect_error` with the message `unauthorized` and the client should stop retrying
until the user signs in again.

## Events the server sends

### `notification:new`

A new notification for this user. The payload is exactly the `Notification`
schema from `openapi.yaml`, plus the fresh badge count.

```json
{
  "notification": {
    "id": "01J9ZQ8K3N",
    "type": "task_assigned",
    "title": "Ada assigned you a task",
    "body": "Design review",
    "link": "/tasks/91",
    "priority": "normal",
    "read": false,
    "createdAt": "2026-09-21T08:14:00.000Z",
    "data": {}
  },
  "unreadCount": 4
}
```

Frontend behaviour: prepend to the list, raise the badge, and show a toast.
Toasts auto-dismiss after 5 seconds, except `priority: "urgent"`, which stays
until the user dismisses it.

### `notification:read`

Sent when a notification is marked read somewhere else — another tab, the phone
app. Keeps every open session in agreement.

```json
{ "id": "01J9ZQ8K3N", "unreadCount": 3 }
```

### `notification:read-all`

```json
{ "unreadCount": 0 }
```

## Events the client sends

None for now. Marking as read goes through the REST endpoints, so there is one
path for that logic, and the server broadcasts the result back over the socket.
Keeping the socket one-directional makes the system much easier to reason about.

## Rules we agreed on

1. The payload shape here must match `openapi.yaml`. If one changes, both change,
   in the same pull request.
2. The client must survive a dropped connection: Socket.IO reconnects on its own,
   and on `reconnect` the client calls `GET /notifications` once to catch up on
   anything missed while offline.
3. Never trust the socket for the badge count on first load. Call
   `GET /notifications/unread-count` on page load, then let socket events adjust it.
