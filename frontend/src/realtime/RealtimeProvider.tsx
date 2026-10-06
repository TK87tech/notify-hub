/**
 * Wires the socket to the query cache and to toasts. Issue #23.
 *
 * Five behaviours here are the difference between "realtime works" and "realtime
 * appears to work":
 *
 *   1. Prepending rather than invalidating. A new notification belongs on page 1
 *      of an infinite list, but `invalidateQueries` would refetch *every* cached
 *      page - several requests, and a visible jump in scroll position. So the
 *      item is inserted directly and the count taken from the payload, because
 *      the server has already told us the authoritative number.
 *   2. A catch-up refetch on reconnect, exactly once. Events sent while the tab
 *      was asleep are lost, not queued, so reconnecting without refetching is
 *      the classic way to end up permanently missing notifications.
 *   3. `notification:read` syncs other tabs. Marking read in tab A must show up
 *      in tab B, which is why the handler patches the cache rather than
 *      ignoring events that happened to originate locally.
 *   4. Urgent toasts are persistent; everything else fades after five seconds.
 *   5. The token is re-read on every reconnect attempt. A tab left open past the
 *      12-hour expiry would otherwise retry with the dead token forever, because
 *      Socket.IO reuses the `auth` payload captured when the socket was created.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { queryKeys } from "@/api/query-keys";
import { readToken } from "@/api/token";
import { useAuth } from "@/auth/auth-context";
import type { Notification } from "@/api/types";
import { connectSocket, SOCKET_URL, type NotifySocket } from "./socket";
import { RealtimeContext, type ConnectionState } from "./realtime-context";
import { REALTIME_EVENTS } from "./events";

/** Non-urgent toasts get out of the way; urgent ones wait to be acknowledged. */
const TOAST_MS = 5_000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  // Starts as "connecting" because that is the state a socket enters the moment it
  // is created; every later value arrives from an event. Assigning it here rather
  // than in the effect body keeps the transition driven by the socket's own
  // lifecycle, and is also what the react-hooks rules require - a setState in the
  // middle of an effect body cascades an extra render on every mount.
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  // Whether this is the first connect. The catch-up refetch is wanted on every
  // *re*connect and on no first connects, because the initial page load has
  // just fetched everything anyway.
  const hasConnected = useRef(false);

  // Derived rather than assigned in the effect below: resetting state on the
  // signed-out path would be a setState in an effect body, which cascades an
  // extra render on every sign-out and is flagged by the react-hooks rules.
  //
  // `usableUrl` covers the third dead end - a socket URL that cannot be dialled.
  // Derived rather than assigned so a synchronous throw from `io()` cannot leave
  // the UI claiming to be "connecting" forever.
  const usableUrl = SOCKET_URL.length > 0;
  const state: ConnectionState = isSignedIn && usableUrl ? connection : "disconnected";

  useEffect(() => {
    if (!isSignedIn) return;

    let socket: NotifySocket;

    try {
      socket = connectSocket();
    } catch {
      // A malformed URL throws synchronously. Realtime is an enhancement - the
      // badge polls every 60s - so this must not take the app down, and nothing
      // here may assign state: `usableUrl` below already reports "disconnected"
      // for this case.
      return;
    }

    // `socket.io` is the Manager, which reports the transitional states the
    // Socket itself never emits. Using it keeps every assignment inside an event
    // handler, which is also what the react-hooks rules want.
    socket.io.on("open", () => setConnection("connecting"));
    socket.io.on("reconnect_attempt", () => setConnection("connecting"));

    socket.on("connect", () => {
      setConnection("connected");

      if (hasConnected.current) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.root });
      }

      hasConnected.current = true;
    });

    socket.on("disconnect", () => setConnection("disconnected"));

    socket.on("connect_error", () => setConnection("disconnected"));

    // Re-read the token before every retry. Socket.IO otherwise replays the
    // `auth` payload captured at creation, so a tab open past the 12-hour
    // expiry would reconnect forever with a token the server always rejects.
    socket.io.on("reconnect_attempt", () => {
      socket.auth = { token: readToken() };
    });

    socket.on(REALTIME_EVENTS.notificationNew, ({ notification, unreadCount }) => {
      prependNotification(queryClient, notification, unreadCount);
      announce(notification);
    });

    socket.on(REALTIME_EVENTS.notificationRead, ({ id, unreadCount }) => {
      // Fires for this tab's own writes too, which is harmless: the optimistic
      // update already marked it and this reconciles with the server's count.
      patchRead(queryClient, id, unreadCount);
    });

    socket.on(REALTIME_EVENTS.notificationReadAll, ({ unreadCount }) => {
      patchAllRead(queryClient, unreadCount);
    });

    return () => {
      socket.close();
    };
  }, [isSignedIn, queryClient]);

  return <RealtimeContext value={{ state }}>{children}</RealtimeContext>;
}

/* -- cache operations -------------------------------------------------- */

type NotificationCache = { pages: { items: Notification[]; unreadCount?: number }[] };

/**
 * Inserts a notification at the top of the first cached page.
 *
 * `setQueriesData` is used with a partial key so this lands on the list cache
 * regardless of which filter or page size produced it.
 */
function prependNotification(
  queryClient: ReturnType<typeof useQueryClient>,
  notification: Notification,
  unreadCount: number,
): void {
  // Per list, because each list has its own filter. A comment must not appear
  // in a list filtered to payments, and an event replayed after a reconnect
  // (connection-state recovery) must not add the same row twice. The unread
  // count is global, so every list takes it either way.
  for (const [key, old] of queryClient.getQueriesData({ queryKey: queryKeys.notifications.root })) {
    const cache = old as NotificationCache | undefined;

    if (!cache?.pages) continue;

    const filter = (key[2] ?? {}) as { type?: string };
    const belongs = !filter.type || filter.type === notification.type;
    const seen = cache.pages.some((page) => page.items.some((item) => item.id === notification.id));
    const add = belongs && !seen;

    queryClient.setQueryData(key, {
      ...cache,
      pages: cache.pages.map((page, index) =>
        index === 0
          ? { ...page, unreadCount, items: add ? [notification, ...page.items] : page.items }
          : page,
      ),
    });
  }

  setUnread(queryClient, unreadCount);
}

function patchRead(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  unreadCount: number,
): void {
  queryClient.setQueriesData({ queryKey: queryKeys.notifications.root }, (old: unknown) => {
    const cache = old as NotificationCache | undefined;

    if (!cache?.pages) return old;

    return {
      ...cache,
      pages: cache.pages.map((page) => ({
        ...page,
        // unreadCount only lives on the first page's envelope.
        ...(page === cache.pages[0] ? { unreadCount } : {}),
        items: page.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
      })),
    };
  });

  setUnread(queryClient, unreadCount);
}

function patchAllRead(
  queryClient: ReturnType<typeof useQueryClient>,
  unreadCount: number,
): void {
  queryClient.setQueriesData({ queryKey: queryKeys.notifications.root }, (old: unknown) => {
    const cache = old as NotificationCache | undefined;

    if (!cache?.pages) return old;

    return {
      ...cache,
      pages: cache.pages.map((page) => ({
        ...page,
        ...(page === cache.pages[0] ? { unreadCount } : {}),
        items: page.items.map((item) => ({ ...item, read: true })),
      })),
    };
  });

  setUnread(queryClient, unreadCount);
}

/** The badge reads a separate endpoint, so it has to be told separately. */
function setUnread(queryClient: ReturnType<typeof useQueryClient>, unreadCount: number): void {
  queryClient.setQueryData(queryKeys.notifications.unread, { unreadCount });
}

/* -- toasts ------------------------------------------------------------ */

/**
 * The link comes from the producer. Only http(s) - absolute or relative - is
 * followed: assigning a `javascript:` URL to location would run it.
 */
function safeHref(link: string | null | undefined): string | null {
  if (!link) return null;

  try {
    const url = new URL(link, window.location.origin);

    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function announce(notification: Notification): void {
  const href = safeHref(notification.link);

  // Urgent means urgent: no auto-dismiss, so someone looking at something else
  // cannot miss it by glancing away for five seconds.
  const duration = notification.priority === "urgent" ? Number.POSITIVE_INFINITY : TOAST_MS;

  toast(notification.title, {
    description: notification.body ?? undefined,
    duration,
    // Keyed by id, so a redelivery after a reconnect updates the existing toast
    // instead of stacking a duplicate next to it.
    id: notification.id,
    action: href
      ? {
          label: "View",
          onClick: () => {
            window.location.assign(href);
          },
        }
      : undefined,
  });
}