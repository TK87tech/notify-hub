/**
 * Query keys, in one place.
 *
 * The reason this is not inlined at each call site: a typo in a key does not
 * throw. It creates a second cache entry, so `queryClient.invalidateQueries` for
 * the bell quietly does nothing to the panel and the unread count drifts out of
 * step with the list. Centralising them means `notifications.root` invalidates
 * every notification view at once, by construction.
 */

export const queryKeys = {
  session: ["session"] as const,

  notifications: {
    root: ["notifications"] as const,
    list: (params: unknown) => ["notifications", "list", params] as const,
    unread: ["notifications", "unread"] as const,
  },

  preferences: ["preferences"] as const,
  devices: ["devices"] as const,
  queueStats: ["ops", "queue-stats"] as const,
};