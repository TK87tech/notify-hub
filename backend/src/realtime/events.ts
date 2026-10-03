/**
 * The event names and payload shapes, in one place.
 *
 * contracts/realtime-events.md is the document; this is the TypeScript mirror
 * of it. Both sides change in the same pull request, and this file is the one
 * that makes a mismatch a compile error rather than a runtime surprise.
 *
 * Every payload is exactly the shape in openapi.yaml - `Notification` here is
 * the schema from the contract, not a Prisma row.
 */

export type NotificationType =
  | "task_assigned"
  | "payment_received"
  | "deadline_warning"
  | "comment"
  | "system";

export type Priority = "urgent" | "normal" | "low";

/** The contract's Notification schema. */
export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  priority: Priority;
  read: boolean;
  createdAt: string;
  data: Record<string, unknown>;
}

export const REALTIME_EVENTS = {
  notificationNew: "notification:new",
  notificationRead: "notification:read",
  notificationReadAll: "notification:read-all",
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export interface ServerToClientEvents {
  "notification:new": (payload: {
    notification: NotificationPayload;
    unreadCount: number;
  }) => void;
  "notification:read": (payload: { id: string; unreadCount: number }) => void;
  "notification:read-all": (payload: { unreadCount: number }) => void;
}

export interface ClientToServerEvents {
  /** Nothing. Marking as read goes through REST so there is one code path. */
  never: never;
}

export interface InterServerEvents {
  /** Reserved. Present so the Socket.IO generic signature is complete. */
  ping: () => void;
}

/** What the handshake middleware puts on the socket for later handlers. */
export interface SocketData {
  userId: string;
}

/**
 * The Redis channel every API instance and every worker shares.
 *
 * Why Redis pub/sub and not a direct call: the worker is a separate process
 * from the API (see docs/BRANCHING.md and the "worker runs as its own
 * process" requirement in issue #13). A worker cannot reach the API's
 * in-memory Socket.IO server, and even if it could it would only reach the one
 * instance it happened to land next to. Publishing to Redis and letting every
 * API instance fan out to its own rooms is what makes this correct with one
 * API process and with ten.
 */
export const REALTIME_REDIS_CHANNEL = "notifyhub:realtime";

/** The room every authenticated connection joins. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** What goes on the wire between processes. */
export interface RealtimeEnvelope {
  userId: string;
  event: RealtimeEvent;
  payload: unknown;
  /** Set when the API process that owns the sockets published it, so it can
   *  skip delivering to its own rooms and avoid a duplicate echo. */
  originId?: string;
}