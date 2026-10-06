/**
 * Issue #23, against the real provider and a stubbed Socket.IO.
 *
 * socket.io-client is mocked rather than run against a server, because the point
 * of these tests is the wiring between events and the query cache - not
 * Socket.IO's own reconnection, which is already tested there.
 *
 * The cache is inspected directly rather than through rendered output. These
 * assertions are about what the *next* render will show, and checking the cache
 * says so without depending on a panel being open.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";

import { useRealtime } from "@/realtime/realtime-context";
import { REALTIME_EVENTS } from "@/realtime/events";
import { queryKeys } from "@/api/query-keys";
import { writeToken } from "@/api/token";
import { toast } from "sonner";
import {
  makeNotification,
  pageOf,
  renderWithProviders,
  routes,
  TEST_USER,
  validToken,
} from "@/test/render";

type Handler = (payload?: unknown) => void;

/**
 * `vi.mock` is hoisted above the imports, so the recorder it writes to has to be
 * hoisted too - a plain top-level const would still be in its temporal dead zone
 * when the factory runs.
 */
const mocks = vi.hoisted(() => ({
  socketHandlers: {} as Record<string, Handler>,
  managerHandlers: {} as Record<string, Handler>,
  auth: {} as Record<string, unknown>,
  close: vi.fn(),
  connectArgs: [] as unknown[],
}));

// The real Toaster still renders; only the call is observed.
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  io: vi.fn((...args: unknown[]) => {
    mocks.connectArgs.push(args[0]);

    return {
      get auth() {
        return mocks.auth;
      },
      set auth(value: Record<string, unknown>) {
        // Copied rather than referenced, so the provider mutating `socket.auth`
        // is observable from the test.
        mocks.auth = { ...value };
      },
      io: {
        on: (event: string, handler: Handler) => {
          mocks.managerHandlers[event] = handler;
        },
        emit: vi.fn(),
      },
      on: (event: string, handler: Handler) => {
        mocks.socketHandlers[event] = handler;
      },
      close: mocks.close,
      emit: vi.fn(),
    };
  }),
}));

beforeEach(() => {
  mocks.socketHandlers = {};
  mocks.managerHandlers = {};
  mocks.auth = {};
  mocks.close.mockClear();
  mocks.connectArgs = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders a consumer that just reports the connection state. */
function StateProbe() {
  const { state } = useRealtime();

  return <p data-testid="state">{state}</p>;
}

function fire(event: string, payload?: unknown): void {
  act(() => mocks.socketHandlers[event]?.(payload));
}

function fireManager(event: string): void {
  act(() => mocks.managerHandlers[event]?.());
}

function sessionStubs() {
  return routes(
    ["/auth/session", { user: TEST_USER }],
    ["/notifications/unread-count", { unreadCount: 0 }],
    ["/notifications?", pageOf([], 0)],
  );
}

describe("RealtimeProvider connection lifecycle", () => {
  it("reports connecting, then connected", async () => {
    writeToken(validToken());

    renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });

    expect(screen.getByTestId("state")).toHaveTextContent("connecting");

    fire("connect");

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("connected"));
  });

  it("never connects while signed out", async () => {
    // An anonymous visitor must not open a socket at all.
    renderWithProviders(<StateProbe />, { signedIn: false, withRealtime: true });

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("disconnected"));

    expect(mocks.connectArgs).toHaveLength(0);
  });

  it("reports disconnected when the connection drops", async () => {
    writeToken(validToken());

    renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });

    fire("connect");

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("connected"));

    fire("disconnect");

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("disconnected"));
  });

  it("refreshes the token before every reconnect attempt", async () => {
    writeToken(validToken());

    renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });

    // As if the user signed in again in another tab.
    writeToken("brand-new-token");

    fireManager("reconnect_attempt");

    // Without this, Socket.IO replays the auth captured at creation and a tab
    // open past the 12-hour expiry retries with a dead token forever.
    expect(mocks.auth).toEqual({ token: "brand-new-token" });
  });

  it("registers a handler for every documented event", async () => {
    writeToken(validToken());

    renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });

    for (const event of Object.values(REALTIME_EVENTS)) {
      expect(mocks.socketHandlers[event], `no handler for ${event}`).toBeTypeOf("function");
    }
  });

  it("closes the socket when the provider unmounts", async () => {
    writeToken(validToken());

    const { unmount } = renderWithProviders(<StateProbe />, {
      withRealtime: true,
      routes: sessionStubs(),
    });

    unmount();

    expect(mocks.close).toHaveBeenCalled();
  });
});

describe("RealtimeProvider cache updates", () => {
  const key = queryKeys.notifications.list({ limit: 20 });

  function seed(client: QueryClient) {
    client.setQueryData(key, {
      pages: [pageOf([makeNotification({ id: "older" })], 1)],
      pageParams: [undefined],
    });
  }

  it("prepends a new notification and adopts the server's unread count", async () => {
    writeToken(validToken());

    const { queryClient } = renderWithProviders(<StateProbe />, {
      withRealtime: true,
      routes: sessionStubs(),
    });

    seed(queryClient);

    fire(REALTIME_EVENTS.notificationNew, {
      notification: makeNotification({ id: "newest", title: "Brand new" }),
      unreadCount: 2,
    });

    const cached = queryClient.getQueryData<{
      pages: { items: { id: string }[]; unreadCount?: number }[];
    }>(key);

    // Prepended, not appended: newest first is the whole point of the panel.
    expect(cached?.pages[0].items.map((item) => item.id)).toEqual(["newest", "older"]);
    // The server's number wins over anything derived locally.
    expect(cached?.pages[0].unreadCount).toBe(2);
    // The badge reads a separate endpoint, so it has to be told separately.
    expect(queryClient.getQueryData(queryKeys.notifications.unread)).toEqual({ unreadCount: 2 });
  });

  it("marks a row read when it happens in another tab", async () => {
    writeToken(validToken());

    const { queryClient } = renderWithProviders(<StateProbe />, {
      withRealtime: true,
      routes: sessionStubs(),
    });

    queryClient.setQueryData(key, {
      pages: [pageOf([makeNotification({ id: "n-1", read: false })], 1)],
      pageParams: [undefined],
    });

    fire(REALTIME_EVENTS.notificationRead, { id: "n-1", unreadCount: 0 });

    const cached = queryClient.getQueryData<{ pages: { items: { read: boolean }[] }[] }>(key);

    expect(cached?.pages[0].items[0].read).toBe(true);
    expect(queryClient.getQueryData(queryKeys.notifications.unread)).toEqual({ unreadCount: 0 });
  });

  it("marks everything read when it happens in another tab", async () => {
    writeToken(validToken());

    const { queryClient } = renderWithProviders(<StateProbe />, {
      withRealtime: true,
      routes: sessionStubs(),
    });

    queryClient.setQueryData(key, {
      pages: [
        pageOf(
          [makeNotification({ id: "n-1", read: false }), makeNotification({ id: "n-2", read: false })],
          2,
        ),
      ],
      pageParams: [undefined],
    });

    fire(REALTIME_EVENTS.notificationReadAll, { unreadCount: 0 });

    const cached = queryClient.getQueryData<{ pages: { items: { read: boolean }[] }[] }>(key);

    expect(cached?.pages[0].items.every((item) => item.read)).toBe(true);
    expect(queryClient.getQueryData(queryKeys.notifications.unread)).toEqual({ unreadCount: 0 });
  });
});

describe("RealtimeProvider de-duplication and filters", () => {
  function seedLists(client: QueryClient) {
    const lists = {
      all: queryKeys.notifications.list({ limit: 20 }),
      payments: queryKeys.notifications.list({ limit: 20, type: "payment_received" }),
    };

    for (const key of Object.values(lists)) {
      client.setQueryData(key, { pages: [pageOf([makeNotification({ id: "older" })], 1)], pageParams: [undefined] });
    }

    return lists;
  }

  const ids = (client: QueryClient, key: readonly unknown[]) =>
    client.getQueryData<{ pages: { items: { id: string }[] }[] }>(key)?.pages[0].items.map((item) => item.id);

  it("adds a replayed event only once", async () => {
    writeToken(validToken());
    const { queryClient } = renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });
    const { all } = seedLists(queryClient);

    const event = { notification: makeNotification({ id: "n1", type: "comment" }), unreadCount: 2 };
    fire(REALTIME_EVENTS.notificationNew, event);
    fire(REALTIME_EVENTS.notificationNew, event);

    expect(ids(queryClient, all)).toEqual(["n1", "older"]);
  });

  it("keeps a notification out of a list filtered to another type, but still updates its count", async () => {
    writeToken(validToken());
    const { queryClient } = renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });
    const { payments } = seedLists(queryClient);

    fire(REALTIME_EVENTS.notificationNew, {
      notification: makeNotification({ id: "c1", type: "comment" }),
      unreadCount: 5,
    });

    expect(ids(queryClient, payments)).toEqual(["older"]);
    expect(
      queryClient.getQueryData<{ pages: { unreadCount?: number }[] }>(payments)?.pages[0].unreadCount,
    ).toBe(5);
  });
});

describe("RealtimeProvider catch-up after a dropped connection", () => {
  it("marks the lists stale on reconnect, not on the first connect", async () => {
    writeToken(validToken());
    const { queryClient } = renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fire("connect");
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("connected"));
    expect(invalidate).not.toHaveBeenCalled();

    fire("disconnect");
    fire("connect");

    // Whatever arrived while offline is refetched, rather than waiting for a
    // manual refresh.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.notifications.root });
  });
});

describe("RealtimeProvider toasts", () => {
  beforeEach(() => vi.mocked(toast).mockClear());

  function announce(overrides: Parameters<typeof makeNotification>[0]) {
    writeToken(validToken());
    renderWithProviders(<StateProbe />, { withRealtime: true, routes: sessionStubs() });
    fire(REALTIME_EVENTS.notificationNew, { notification: makeNotification(overrides), unreadCount: 1 });

    return vi.mocked(toast).mock.calls.at(-1)!;
  }

  it("shows the title and body, and dismisses a normal one after a few seconds", () => {
    const [title, options] = announce({ id: "t1", title: "Task assigned", body: "Review the PR", priority: "normal" });

    expect(title).toBe("Task assigned");
    expect(options).toMatchObject({ description: "Review the PR", duration: 5_000, id: "t1" });
  });

  it("never auto-dismisses an urgent one", () => {
    const [, options] = announce({ priority: "urgent" });

    expect(options?.duration).toBe(Number.POSITIVE_INFINITY);
  });

  it("offers View for an http(s) link but not for a javascript: one", () => {
    expect(announce({ link: "/tasks/1" })[1]?.action).toMatchObject({ label: "View" });
    expect(announce({ link: "javascript:alert(1)" })[1]?.action).toBeUndefined();
  });
});
