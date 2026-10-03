/**
 * The realtime event contract, mirrored from the server.
 *
 * `backend/src/realtime/events.ts` is the source of truth and
 * `contracts/realtime-events.md` is the document; this is the third copy, and it
 * exists because the browser cannot import from the backend. The payloads are
 * kept structurally identical on purpose: if the server adds a field, adding it
 * here should be the only edit needed, and forgetting it is a type error rather
 * than `undefined` at runtime.
 */

import type { Notification } from "@/api/types";

export const REALTIME_EVENTS = {
  notificationNew: "notification:new",
  notificationRead: "notification:read",
  notificationReadAll: "notification:read-all",
} as const;

export interface ServerToClientEvents {
  /** A notification was delivered. `unreadCount` is the server's count after it. */
  "notification:new": (payload: { notification: Notification; unreadCount: number }) => void;
  /** Emitted when *any* session marks one read, including another tab. */
  "notification:read": (payload: { id: string; unreadCount: number }) => void;
  "notification:read-all": (payload: { unreadCount: number }) => void;
}

/** Nothing is sent from the browser; marking read goes through REST. */
export interface ClientToServerEvents {
  never: never;
}

/** The handshake message the gateway sends for a rejected token. */
export const UNAUTHORIZED_MESSAGE = "unauthorized";