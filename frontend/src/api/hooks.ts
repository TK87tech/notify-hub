/**
 * TanStack Query hooks, one per endpoint.
 *
 * The invalidation rules are the interesting part and they are stated here rather
 * than at the call site, because they are what keeps the badge and the list from
 * disagreeing:
 *
 *   - Marking read touches every cached page of the list. Otherwise page 2 would
 *     still show the row as unread after page 1 was marked.
 *   - Any notification change also invalidates the unread count, because the
 *     badge reads a separate endpoint and would otherwise keep the old number.
 *   - Live pushes from the socket invalidate the list root, not the pages
 *     individually: a new notification belongs on page 1 and cannot be inserted
 *     into an arbitrary cached page without guessing where it landed.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  fetchPreferences,
  fetchQueueStats,
  fetchSession,
  fetchUnreadCount,
  listNotifications,
  markAllRead,
  markRead,
  registerDevice,
  updatePreferences,
  type ListNotificationsParams,
} from "./endpoints";
import { queryKeys } from "./query-keys";
import type { Notification } from "./types";

/** How often the unread badge re-checks while the tab is visible. */
const UNREAD_POLL_MS = 60_000;

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: fetchSession,
    // A 401 here means the stored token is no longer good, which the auth
    // provider handles by signing out. Retrying would just produce more 401s.
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useNotifications(params: ListNotificationsParams = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list(params),
    queryFn: ({ pageParam }) => listNotifications({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: queryKeys.notifications.unread,
    queryFn: fetchUnreadCount,
    refetchInterval: UNREAD_POLL_MS,
    // Polling a tab nobody is looking at is how a free-tier database gets
    // throttled for no benefit.
    refetchIntervalInBackground: false,
  });
}

/**
 * Marks one notification read, updating the cache first.
 *
 * The optimistic update is what makes the row stop looking unread immediately;
 * the rollback exists because a failed PATCH that left the row marked read would
 * be a lie the user could not see the end of.
 */
export function useMarkRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => markRead(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.root });

      const previous = queryClient.getQueriesData({
        queryKey: queryKeys.notifications.root,
      });

      queryClient.setQueriesData(
        { queryKey: queryKeys.notifications.root },
        (old: unknown) => patchReadIn(old, id),
      );

      return { previous };
    },
    onError: (_error, _id, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.root });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: markAllRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.root });

      const previous = queryClient.getQueriesData({
        queryKey: queryKeys.notifications.root,
      });

      queryClient.setQueriesData(
        { queryKey: queryKeys.notifications.root },
        (old: unknown) => patchAllRead(old),
      );

      return { previous };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications.root });
    },
  });
}

export function usePreferences() {
  return useQuery({
    queryKey: queryKeys.preferences,
    queryFn: fetchPreferences,
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updatePreferences,
    onSuccess: (saved) => {
      // Replaced rather than invalidated: the API echoes the stored document
      // back, so a refetch would only confirm what we already have.
      queryClient.setQueryData(queryKeys.preferences, saved);
    },
  });
}

export function useRegisterDevice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: registerDevice,
    // Nothing else is cached per device, but a success should still clear any
    // stale registration state held by the push-opt-in flow.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useQueueStats() {
  return useQuery({
    queryKey: queryKeys.queueStats,
    queryFn: fetchQueueStats,
    // An operations view does not need to be current to the second, and this one
    // queries Redis and Postgres on every call.
    refetchInterval: 30_000,
  });
}

/* -- cache helpers ------------------------------------------------------ */

type InfiniteData = { pages: { items: Notification[] }[] };

/**
 * Marks one row read across every cached page.
 *
 * Structured as a plain reducer over the unknown cache shape rather than typed
 * generics, because the cached value comes back as whatever a previous fetch
 * produced and a cast at the boundary is more honest than pretending the shape
 * is guaranteed.
 */
function patchReadIn(cached: unknown, id: string): unknown {
  const data = cached as InfiniteData | undefined;

  if (!data?.pages) return cached;

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    })),
  };
}

function patchAllRead(cached: unknown): unknown {
  const data = cached as InfiniteData | undefined;

  if (!data?.pages) return cached;

  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      // The unreadCount lives on page 1's envelope, so it is reset there rather
      // than on every page - only the first page's copy is ever read.
      ...(page === data.pages[0] ? { unreadCount: 0 } : {}),
      items: page.items.map((item) => ({ ...item, read: true })),
    })),
  };
}