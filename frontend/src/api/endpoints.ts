/**
 * One function per endpoint, each returning the contract's type.
 *
 * Deliberately not generated. A generated client would save maybe forty lines
 * here and cost the ability to name the query key and the invalidation strategy
 * next to the call that needs it - and those are the parts that actually decide
 * whether the unread badge is correct.
 *
 * Paths carry no `/api/v1` prefix: the contract's server URL already ends in it,
 * so adding it here would produce `/api/v1/api/v1/notifications`.
 *
 * Methods and paths are transcribed from `contracts/openapi.yaml`:
 *   POST /auth/sign-in          GET  /auth/session
 *   GET  /notifications          GET  /notifications/unread-count
 *   PATCH /notifications/{id}/read
 *   PATCH /notifications/read-all
 *   GET  /preferences            PUT  /preferences
 *   POST /devices                GET  /ops/queue-stats
 */

import { request } from "./client";
import type {
  Notification,
  NotificationPage,
  NotificationStatusFilter,
  NotificationType,
  Preferences,
  QueueStats,
  Session,
  User,
} from "./types";

/* -- auth -------------------------------------------------------------- */

export async function signIn(email: string, password: string): Promise<Session> {
  return request<Session>("/auth/sign-in", {
    method: "POST",
    body: { email, password },
    anonymous: true,
  });
}

export async function fetchSession(): Promise<User> {
  return request<User>("/auth/session");
}

/* -- notifications ----------------------------------------------------- */

export interface ListNotificationsParams {
  cursor?: string;
  /** The API caps this at 50. */
  limit?: number;
  status?: NotificationStatusFilter;
  type?: NotificationType;
}

export async function listNotifications(
  params: ListNotificationsParams = {},
): Promise<NotificationPage> {
  const query = new URLSearchParams();

  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.status) query.set("status", params.status);
  if (params.type) query.set("type", params.type);

  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return request<NotificationPage>(`/notifications${suffix}`);
}

export async function fetchUnreadCount(): Promise<{ unreadCount: number }> {
  return request<{ unreadCount: number }>("/notifications/unread-count");
}

/**
 * Marks one notification read.
 *
 * Resolves to null rather than void because the panel does not want the response:
 * it updates its own cache optimistically, and a 200 arriving afterwards must
 * not re-render the row it just updated.
 */
export async function markRead(id: string): Promise<Notification | null> {
  return request<Notification | null>(`/notifications/${id}/read`, { method: "PATCH" });
}

/** PATCH, not POST - the route toggles state rather than creating anything. */
export async function markAllRead(): Promise<{ updated: number }> {
  return request<{ updated: number }>("/notifications/read-all", { method: "PATCH" });
}

/* -- preferences ------------------------------------------------------- */

export async function fetchPreferences(): Promise<Preferences> {
  return request<Preferences>("/preferences");
}

/**
 * PUT, not PATCH: preferences are a whole document, and a partial update would
 * make it impossible to clear a field. The whole object goes up unchanged apart
 * from the user's edits.
 */
export async function updatePreferences(preferences: Preferences): Promise<Preferences> {
  return request<Preferences>("/preferences", {
    method: "PUT",
    body: preferences,
  });
}

/* -- devices ----------------------------------------------------------- */

export interface DeviceRegistration {
  token: string;
  platform: string;
}

export interface Device extends DeviceRegistration {
  id: string;
  createdAt: string;
}

/**
 * The only device route in the contract is POST /devices.
 *
 * There is deliberately no list or delete: this client cannot show a device
 * list or unregister a token, and inventing those calls would produce buttons
 * that always fail. Unregistering happens on the API side when a token is
 * replaced.
 */
export async function registerDevice(input: DeviceRegistration): Promise<Device> {
  return request<Device>("/devices", { method: "POST", body: input });
}

/* -- operations -------------------------------------------------------- */

export async function fetchQueueStats(): Promise<QueueStats> {
  return request<QueueStats>("/ops/queue-stats");
}