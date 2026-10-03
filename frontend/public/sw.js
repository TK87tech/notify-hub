/**
 * Service worker for browser push. Issue #25.
 *
 * This file is served verbatim out of `public/` instead of being bundled, so it
 * stays a plain script that boots on its own. It is the only thing that turns a
 * push message into something a person sees: the backend posts to FCM, FCM wakes
 * this worker, and everything after that happens here.
 *
 * Two details are load-bearing:
 *
 * - The payload shape is not something to assume. What arrives is JSON that has
 *   travelled through FCM's webpush transport, and the same message has appeared
 *   under more than one shape across FCM versions. `readMessage` accepts several
 *   and degrades instead of throwing, because a push handler that throws shows
 *   the user nothing and there is no second chance to render it.
 * - `link` is chosen by the backend and ends up as a navigation target. It is
 *   resolved against this origin and refused if it points off-site: a push
 *   message is not a place to trust a URL from.
 */

/** Where a click goes when the sender gave us nothing usable to open. */
const DEFAULT_LINK = "/notifications";

/** Shown only when the payload has no title at all. */
const FALLBACK_TITLE = "NotifyHub";

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close. The worker
  // holds no state worth protecting, and a user who has just deployed expects the
  // new worker on the next load.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // The worker that was installed *before* a new deploy never receives a push,
  // so without this a user can be up to a full deploy cycle behind on updates.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  // Used by nothing today. Exists so a future deploy can trigger an update from
  // the app without inventing a second channel.
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event.data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // "dismiss" means the user swiped it away. Opening a window anyway would be
  // arguing with a decision they just made.
  if (event.action === "dismiss") return;

  event.waitUntil(openNotification(event.notification));
});

/** Renders a push message. Never rejects: a throw here loses the notification. */
async function showPush(data) {
  const message = readMessage(data);

  const options = {
    body: message.body,
    // Tagging by notification id means a retried send replaces its own earlier
    // notification instead of stacking a second copy. Deliberately no
    // `renotify`: re-alerting on replacement is the opposite of what a duplicate
    // send needs.
    ...(message.notificationId ? { tag: message.notificationId } : {}),
    data: {
      link: message.link,
      notificationId: message.notificationId,
    },
  };

  try {
    await self.registration.showNotification(message.title, options);
  } catch (err) {
    // Rejected when permission was revoked between opting in and delivery.
    // Logging is the only useful thing left; there is no notification to save.
    console.error("[sw] could not show notification", err);
  }
}

/**
 * Pulls the useful fields out of whatever FCM sent.
 *
 * Returns `title` always. `body` and `link` may be undefined, and the caller is
 * written to cope with that rather than to assume them.
 */
function readMessage(data) {
  const payload = parseJson(data);

  // `notification` is where the backend's title and body live. The `message.*`
  // path is FCM's older wrapping and the bare path is what some webpush
  // senders produce; checking all three costs nothing and removes a whole class
  // of "works locally, blank in production".
  const notification = asRecord(payload.notification) ?? asRecord(payload.message?.notification) ?? {};

  // Data carries what a notification payload cannot: the id and the link.
  const values = asRecord(payload.data) ?? {};

  const title = firstString(notification.title, values.title, FALLBACK_TITLE);
  const body = firstString(notification.body, values.body);
  const link = firstString(values.link, payload.fcmOptions?.link);

  // The backend always sends notificationId, so this is the path that runs in
  // practice; `id` is here so a hand-rolled sender still gets tagged.
  const notificationId = firstString(values.notificationId, values.id);

  return {
    title,
    body,
    link: resolveLink(link),
    notificationId,
  };
}

/** Unparseable payloads are common enough to be worth a fallback rather than a throw. */
function parseJson(data) {
  if (!data || typeof data.text !== "function") return {};

  try {
    const parsed = JSON.parse(data.text());
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** First argument that is a non-empty string. */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }

  return undefined;
}

/**
 * Turns a sender-supplied link into a same-origin path.
 *
 * Anything off-origin collapses to the notifications page rather than being
 * dropped, so a bad value costs the user their intended destination instead of
 * landing them on a stranger's site.
 */
function resolveLink(value) {
  if (!value) return DEFAULT_LINK;

  try {
    const base = new URL(DEFAULT_LINK, self.location.origin);
    const target = new URL(value, base);

    if (target.origin !== base.origin) return DEFAULT_LINK;

    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return DEFAULT_LINK;
  }
}

/**
 * Puts the user in front of the thing that was notified about.
 *
 * A tab already open on that page is preferred over opening a second one, which
 * is the difference between a click and a duplicate session.
 */
async function openNotification(notification) {
  const link = resolveLink(notification.data?.link);

  const windows = await self.clients.matchAll({
    type: "window",
    // Without this, a tab that was loaded before the worker existed is excluded
    // and every click opens a new one.
    includeUncontrolled: true,
  });

  const exact = windows.find((client) => pathOf(client.url) === link);

  if (exact) {
    await exact.focus();
    return exact;
  }

  // Some other tab is open. Focus it and send it to the right place rather than
  // opening another window.
  const existing = windows[0];

  if (existing) {
    await existing.focus();

    if (pathOf(existing.url) !== link && typeof existing.navigate === "function") {
      await existing.navigate(link);
    }

    return existing;
  }

  return self.clients.openWindow(link);
}

/**
 * An absolute URL as the same-origin path + query + hash `resolveLink` returns.
 *
 * Both sides of every comparison in the click handler go through here, because
 * comparing a `URL.pathname` against a path that still carries `?filter=unread`
 * silently fails to match - which reads as "no tab was open", and sends an
 * already-correct tab on a pointless reload.
 */
function pathOf(url) {
  if (typeof url !== "string") return undefined;

  try {
    const base = new URL(DEFAULT_LINK, self.location.origin);
    const parsed = new URL(url, base);

    if (parsed.origin !== base.origin) return undefined;

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}