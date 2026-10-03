/**
 * Issue #25, the worker half of browser push.
 *
 * These tests run `public/sw.js` itself rather than a copy of its logic, because
 * a copy is exactly how the shipped file drifts out of test coverage. The source
 * comes in as a string and is executed with a stubbed `self`, so what is
 * asserted is the file the browser gets.
 *
 * Two failure modes are worth the effort of running the real thing:
 *
 * - A payload shape that throws loses the notification outright, with no
 *   fallback and nothing in the console. Hence the malformed and empty cases.
 * - A click handler that trusts `link` can navigate a user off-site. The
 *   off-origin case is asserted explicitly for that reason.
 */

import { describe, expect, it, vi } from "vitest";

// The worker as it is served. `?raw` keeps it out of the bundle while still
// letting this test execute the deployed text.
import swSource from "../../public/sw.js?raw";

const ORIGIN = "https://notify.example.com";

interface Shown {
  title: string;
  options: { body?: string; tag?: string; data?: { link?: string; notificationId?: string } };
}

interface StubClient {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

function createHarness(clients: StubClient[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const state = { claimed: 0, skipped: 0 };

  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: async () => {
      state.skipped += 1;
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url: string) => {
        opened.push(url);
        return { url };
      },
      claim: async () => {
        state.claimed += 1;
      },
    },
    registration: {
      showNotification: async (title: string, options: Shown["options"]) => {
        shown.push({ title, options });
      },
    },
    location: { origin: ORIGIN },
  };

  // The worker references everything through `self`, so one parameter is enough
  // to run the real file against a stub.
  new Function("self", swSource)(self);

  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    const listener = listeners.get(type);

    if (!listener) throw new Error(`sw.js has no ${type} listener`);

    const pending: Promise<unknown>[] = [];

    listener({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(Promise.resolve(p)) });

    await Promise.all(pending);
  };

  return {
    shown,
    opened,
    state,
    clients,
    /** Fire a `push` with a JSON body, or with raw text via `rawText`. */
    push: (payload?: unknown, rawText?: string) =>
      dispatch("push", {
        data:
          payload === undefined && rawText === undefined
            ? undefined
            : { text: () => rawText ?? JSON.stringify(payload) },
      }),
    // A real Notification always has close(), and the worker calls it first.
    click: (data: unknown, action?: string) =>
      dispatch("notificationclick", { notification: { data, close: vi.fn() }, action }),
    install: () => dispatch("install"),
    activate: () => dispatch("activate"),
  };
}

function client(url: string): StubClient {
  return { url, focus: vi.fn(), navigate: vi.fn() };
}

/** The exact shape `backend/src/channels/push/fcm.ts` sends. */
function fcmMessage() {
  return {
    notification: { title: "Deploy finished", body: "All checks are green." },
    data: { notificationId: "n-42", link: "/notifications?filter=unread", severity: "info" },
  };
}

describe("service worker lifecycle", () => {
  it("activates immediately and takes over open tabs", async () => {
    // Without skipWaiting a user can be a full deploy cycle behind, and without
    // claim() the tab they are clicking in is uncontrolled.
    const sw = createHarness();

    await sw.install();
    await sw.activate();

    expect(sw.state.skipped).toBe(1);
    expect(sw.state.claimed).toBe(1);
  });
});

describe("push", () => {
  it("shows the title, body and tag from an FCM payload", async () => {
    const sw = createHarness();

    await sw.push(fcmMessage());

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("Deploy finished");
    expect(sw.shown[0].options.body).toBe("All checks are green.");
    // The tag is what makes a retried send replace its own earlier notification
    // instead of stacking a duplicate.
    expect(sw.shown[0].options.tag).toBe("n-42");
    expect(sw.shown[0].options.data).toEqual({
      link: "/notifications?filter=unread",
      notificationId: "n-42",
    });
  });

  it("omits the tag when the sender gave no id", async () => {
    const sw = createHarness();

    await sw.push({ notification: { title: "Hello" } });

    expect(sw.shown[0].title).toBe("Hello");
    expect(sw.shown[0].options.tag).toBeUndefined();
  });

  it("still shows something when the body is unparseable", async () => {
    // The failure this prevents is the expensive one: a throwing handler drops
    // the notification silently and permanently.
    const sw = createHarness();

    await sw.push(undefined, "{not json");

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].title).toBe("NotifyHub");
  });

  it("still shows something when there is no payload at all", async () => {
    const sw = createHarness();

    await sw.push();

    expect(sw.shown).toHaveLength(1);
  });

  it("reads the older message-wrapped shape", async () => {
    const sw = createHarness();

    await sw.push({ message: { notification: { title: "Older shape" } } });

    expect(sw.shown[0].title).toBe("Older shape");
  });

  it("falls back to the notifications page when the link is off-origin", async () => {
    const sw = createHarness();

    await sw.push({
      notification: { title: "Hi" },
      data: { notificationId: "n-1", link: "https://evil.example.com/steal" },
    });

    expect(sw.shown[0].options.data?.link).toBe("/notifications");
  });
});

describe("notificationclick", () => {
  it("focuses the tab already on the linked page", async () => {
    const target = client(`${ORIGIN}/notifications?filter=unread`);
    const sw = createHarness([target]);

    await sw.click({ link: "/notifications?filter=unread" });

    expect(target.focus).toHaveBeenCalledOnce();
    // A second tab on the same page is the bug worth avoiding here.
    expect(target.navigate).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it("reuses an unrelated open tab rather than opening another", async () => {
    const other = client(`${ORIGIN}/`);
    const sw = createHarness([other]);

    await sw.click({ link: "/notifications" });

    expect(other.focus).toHaveBeenCalledOnce();
    expect(other.navigate).toHaveBeenCalledExactlyOnceWith("/notifications");
    expect(sw.opened).toEqual([]);
  });

  it("opens a window when the app is not running", async () => {
    const sw = createHarness();

    await sw.click({ link: "/notifications?filter=unread" });

    expect(sw.opened).toEqual(["/notifications?filter=unread"]);
  });

  it("defaults to the notifications page when no link was sent", async () => {
    const sw = createHarness();

    await sw.click({});

    expect(sw.opened).toEqual(["/notifications"]);
  });

  it("does not open anything when the notification was dismissed", async () => {
    // "dismiss" is the user saying no. Opening a window anyway contradicts them.
    const sw = createHarness([client(`${ORIGIN}/`)]);

    await sw.click({ link: "/notifications" }, "dismiss");

    expect(sw.opened).toEqual([]);
    expect(sw.clients[0].focus).not.toHaveBeenCalled();
  });
});