/**
 * Issue #22, and issue #26's "expired token handled without the app crashing".
 *
 * These are the behaviours a user notices first: whether the badge is honest
 * about zero, whether clicking a row marks it read, and what happens when the
 * session dies while the tab is open.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NotificationBell } from "@/features/notifications/NotificationBell";
import { NotificationRow } from "@/features/notifications/NotificationRow";
import ProtectedRoute from "@/routes/ProtectedRoute";
import {
  failingRoutes,
  jsonResponse,
  makeNotification,
  pageOf,
  renderWithProviders,
  routes,
  TEST_USER,
} from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Endpoints every signed-in test needs, so each test only adds its own. */
function sessionRoutes() {
  return routes(["/auth/session", { user: TEST_USER }]);
}

describe("NotificationBell", () => {
  it("shows no badge when there is nothing unread", async () => {
    renderWithProviders(<NotificationBell />, {
      routes: { ...sessionRoutes(), ...routes(["/notifications/unread-count", { unreadCount: 0 }]) },
    });

    // The accessible name is the assertion, not the CSS: a badge that is present
    // but invisible would pass a snapshot and still be wrong for a screen reader.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument(),
    );

    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows the unread count once it loads", async () => {
    renderWithProviders(<NotificationBell />, {
      routes: { ...sessionRoutes(), ...routes(["/notifications/unread-count", { unreadCount: 3 }]) },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "3 unread notifications" })).toBeInTheDocument(),
    );

    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("caps the displayed count at 99+", async () => {
    renderWithProviders(<NotificationBell />, {
      routes: { ...sessionRoutes(), ...routes(["/notifications/unread-count", { unreadCount: 150 }]) },
    });

    await waitFor(() => expect(screen.getByText("99+")).toBeInTheDocument());
  });

  it("marks everything read with a PATCH and empties the badge", async () => {
    const user = userEvent.setup();

    // Stateful rather than static: a stub that always answers 2 would let this
    // pass while the badge never actually emptied, which is the whole point.
    let unread = 2;

    const { fetchMock } = renderWithProviders(<NotificationBell />, {
      routes: {
        ...sessionRoutes(),
        "/notifications/unread-count": () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ unreadCount: unread }),
          } as Response),
        ...routes(["/notifications?", pageOf([makeNotification()], 2)]),
        // Flips the counter when the PATCH actually lands, so the refetch that
        // follows the invalidation sees the new count - which is what makes the
        // final assertion meaningful rather than a stub artefact.
        "/notifications/read-all": () => {
          unread = 0;

          return Promise.resolve(jsonResponse({ updated: 2 }));
        },
      },
    });

    await waitFor(() => expect(screen.getByText("2")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /unread notifications/ }));
    await user.click(await screen.findByRole("button", { name: /Mark all read/ }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("read-all"));

      expect(calls).toHaveLength(1);
      // PATCH, not POST: the contract defines the route as a state toggle.
      expect(calls[0][1].method).toBe("PATCH");
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument(),
    );

    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("does not fetch the panel's rows until it is opened", async () => {
    const { fetchMock } = renderWithProviders(<NotificationBell />, {
      routes: {
        ...sessionRoutes(),
        ...routes(
          ["/notifications/unread-count", { unreadCount: 1 }],
          ["/notifications?", pageOf([makeNotification()], 1)],
        ),
      },
    });

    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

    // Eagerly fetching a panel nobody opened would cost a request per page load.
    const listCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/notifications?"),
    );

    expect(listCalls).toHaveLength(0);
  });

  it("marks read and follows the link when a row is clicked", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NotificationBell />, {
      routes: {
        ...sessionRoutes(),
        ...routes(
          ["/notifications/unread-count", { unreadCount: 1 }],
          ["/notifications?", pageOf([makeNotification({ link: "/tasks/91" })], 1)],
          ["/n-1/read", makeNotification({ link: "/tasks/91", read: true })],
        ),
      },
    });

    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /unread notifications/ }));

    const row = await screen.findByRole("link", { name: /Ada assigned you a task/ });

    expect(row).toHaveAttribute("href", "/tasks/91");

    await user.click(row);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/n-1/read"));

      expect(calls).toHaveLength(1);
      expect(calls[0][1].method).toBe("PATCH");
    });
  });

  it("shows an empty state rather than an empty box", async () => {
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />, {
      routes: {
        ...sessionRoutes(),
        ...routes(
          ["/notifications/unread-count", { unreadCount: 0 }],
          ["/notifications?", pageOf([], 0)],
        ),
      },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));

    expect(await screen.findByText("You are all caught up")).toBeInTheDocument();
  });

  it("reports a failed load instead of looking empty", async () => {
    const user = userEvent.setup();
    const stubs = sessionRoutes();

    renderWithProviders(<NotificationBell />, {
      routes: {
        ...stubs,
        ...routes(["/notifications/unread-count", { unreadCount: 0 }]),
        ...failingRoutes(500, "/notifications?"),
      },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Notifications" }));

    // "Could not load" and "nothing here" are different states and must not look
    // the same - conflating them hides a broken API behind an empty inbox.
    expect(await screen.findByText("Could not load notifications")).toBeInTheDocument();
  });
});

describe("NotificationBell keyboard access", () => {
  it("opens from the keyboard, and Escape closes it and returns focus to the bell", async () => {
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />, {
      routes: {
        ...sessionRoutes(),
        ...routes(["/notifications/unread-count", { unreadCount: 0 }], ["/notifications?", pageOf([], 0)]),
      },
    });

    const bell = await screen.findByRole("button", { name: "Notifications" });

    await user.tab();
    expect(bell).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bell).toHaveFocus();
  });
});

describe("NotificationRow", () => {
  it("announces unread state rather than relying on colour alone", () => {
    renderWithProviders(<NotificationRow notification={makeNotification({ read: false })} />);

    expect(within(screen.getByRole("link")).getByText("Unread.")).toBeInTheDocument();
  });

  it("omits the unread marker once read", () => {
    renderWithProviders(<NotificationRow notification={makeNotification({ read: true })} />);

    expect(screen.queryByText("Unread.")).not.toBeInTheDocument();
  });

  it("shows a badge for urgent but not for normal", () => {
    const { unmount } = renderWithProviders(
      <NotificationRow notification={makeNotification({ priority: "urgent" })} />,
    );

    expect(screen.getByText("urgent")).toBeInTheDocument();
    unmount();

    renderWithProviders(<NotificationRow notification={makeNotification({ priority: "normal" })} />);

    expect(screen.queryByText("normal")).not.toBeInTheDocument();
  });

  it("tolerates a notification with no priority at all", () => {
    // `priority` is optional in the contract, so indexing a variant map with
    // undefined would take down the whole list.
    const notification = makeNotification();
    delete (notification as { priority?: string }).priority;

    expect(() =>
      renderWithProviders(<NotificationRow notification={notification} />),
    ).not.toThrow();
  });

  it("does not issue a read request for an already-read notification", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <NotificationRow notification={makeNotification({ read: true, link: "/tasks/91" })} />,
    );

    await user.click(screen.getByRole("link"));

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/read"))).toHaveLength(0);
  });

  it("points at / when a notification has no link", () => {
    renderWithProviders(<NotificationRow notification={makeNotification({ link: null })} />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/");
  });
});

describe("ProtectedRoute", () => {
  it("shows a checking state rather than flashing the wrong screen", async () => {
    renderWithProviders(
      <ProtectedRoute>
        <p>Secret content</p>
      </ProtectedRoute>,
      { routes: sessionRoutes() },
    );

    // Signed in but not yet confirmed: the guard must render neither the content
    // nor a redirect, or the user sees a flash of the wrong screen.
    expect(screen.getByText("Checking your session")).toBeInTheDocument();
    expect(screen.queryByText("Secret content")).not.toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign-in and does not render the content", async () => {
    renderWithProviders(
      <ProtectedRoute>
        <p>Secret content</p>
      </ProtectedRoute>,
      { signedIn: false },
    );

    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());

    expect(screen.queryByText("Secret content")).not.toBeInTheDocument();
  });

  it("renders the content once the session is confirmed", async () => {
    renderWithProviders(
      <ProtectedRoute>
        <p>Secret content</p>
      </ProtectedRoute>,
      { routes: sessionRoutes() },
    );

    expect(await screen.findByText("Secret content")).toBeInTheDocument();
  });

  it("signs the user out when the session probe is rejected", async () => {
    renderWithProviders(
      <ProtectedRoute>
        <p>Secret content</p>
      </ProtectedRoute>,
      { routes: failingRoutes(401, "/auth/session") },
    );

    // Issue #26: an expired token must be handled, not crash or hang.
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());

    expect(screen.queryByText("Secret content")).not.toBeInTheDocument();
  });
});