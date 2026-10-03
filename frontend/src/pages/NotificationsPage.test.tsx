/**
 * Issue #25 / #31, the full notification list.
 *
 * The filter and paging assertions deliberately check the request the page
 * makes, not just what it renders: `status=read` and a mis-wired cursor both
 * produce a plausible-looking list, so only the outgoing query tells you which
 * of the two happened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import NotificationsPage from "@/pages/NotificationsPage";
import {
  jsonResponse,
  makeNotification,
  pageOf,
  renderWithProviders,
  routes,
  type Routes,
} from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The query the page asked for, as a URLSearchParams. */
function listCalls(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/notifications?"))
    .map((url) => new URL(url, "http://api.test").searchParams);
}

function stubList(pages: Record<string, unknown>, fallback?: Routes) {
  return {
    "/notifications/unread-count": () => Promise.resolve(jsonResponse({ unreadCount: 0 })),
    "/notifications?": (url: string) => {
      const cursor = new URL(url, "http://api.test").searchParams.get("cursor") ?? "";

      return Promise.resolve(jsonResponse(pages[cursor] ?? pages.default));
    },
    ...fallback,
  };
}

describe("NotificationsPage", () => {
  it("renders the first page", async () => {
    renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: { ...pageOf([makeNotification({ id: "n-1", title: "First" })]), nextCursor: null },
      }),
    });

    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("asks for the all filter by default", async () => {
    const { fetchMock } = renderWithProviders(<NotificationsPage />, {
      routes: stubList({ default: { ...pageOf([]), nextCursor: null } }),
    });

    await screen.findByText(/no notifications yet/i);

    const [first] = listCalls(fetchMock);

    expect(first.get("status")).toBe("all");
    expect(first.get("limit")).toBe("20");
  });

  it("appends the next page on the cursor rather than replacing the list", async () => {
    const user = userEvent.setup();

    renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: {
          ...pageOf([makeNotification({ id: "n-1", title: "Older one" })]),
          nextCursor: "cursor-2",
        },
        "cursor-2": {
          ...pageOf([makeNotification({ id: "n-2", title: "Newer one" })]),
          nextCursor: null,
        },
      }),
    });

    await screen.findByText("Older one");

    await user.click(screen.getByRole("button", { name: "Load more" }));

    // Both rows present: paging must accumulate, not overwrite.
    expect(await screen.findByText("Newer one")).toBeInTheDocument();
    expect(screen.getByText("Older one")).toBeInTheDocument();

    // And the button is gone once the cursor runs out.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("keeps unread items visibly distinct from read ones", async () => {
    renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: {
          ...pageOf([
            makeNotification({ id: "n-1", title: "Still unread", read: false }),
            makeNotification({ id: "n-2", title: "Already read", read: true }),
          ]),
          nextCursor: null,
        },
      }),
    });

    await screen.findByText("Still unread");

    // Scoped from the link up to its <li>: the listitem itself has no accessible
    // name of its own, so querying it by name would not match anything.
    const unreadRow = screen.getByRole("link", { name: /still unread/i }).closest("li")!;
    const readRow = screen.getByRole("link", { name: /already read/i }).closest("li")!;

    // Not colour alone: a screen reader has to be able to tell them apart.
    expect(within(unreadRow).getByText("Unread.")).toBeInTheDocument();
    expect(within(readRow).queryByText("Unread.")).toBeNull();
  });

  it("disables mark-all-read when there is nothing unread", async () => {
    renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: {
          ...pageOf([makeNotification({ id: "n-1", read: true })]),
          nextCursor: null,
        },
      }),
    });

    await screen.findByText("Ada assigned you a task");

    // An empty list must not enable this: [].every() is true, so the check has
    // to be on a row actually being unread.
    expect(screen.getByRole("button", { name: /mark all read/i })).toBeDisabled();
  });

  it("enables mark-all-read when something is unread", async () => {
    renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: { ...pageOf([makeNotification({ read: false })]), nextCursor: null },
      }),
    });

    await screen.findByText("Ada assigned you a task");

    expect(screen.getByRole("button", { name: /mark all read/i })).toBeEnabled();
  });

  it("refetches with the unread status when the filter changes", async () => {
    const user = userEvent.setup();

    const { fetchMock } = renderWithProviders(<NotificationsPage />, {
      routes: stubList({ default: { ...pageOf([]), nextCursor: null } }),
    });

    await screen.findByText(/no notifications yet/i);

    await user.click(screen.getByRole("combobox", { name: /filter by read status/i }));
    await user.click(await screen.findByRole("option", { name: "Unread" }));

    await waitFor(() => {
      const statuses = listCalls(fetchMock).map((params) => params.get("status"));

      // `unread`, and never `read` - the API has no such filter.
      expect(statuses).toContain("unread");
      expect(statuses).not.toContain("read");
    });
  });

  it("explains an empty unread filter differently from an empty history", async () => {
    const user = userEvent.setup();

    renderWithProviders(<NotificationsPage />, {
      routes: stubList({ default: { ...pageOf([]), nextCursor: null } }),
    });

    await screen.findByText(/no notifications yet/i);

    await user.click(screen.getByRole("combobox", { name: /filter by read status/i }));
    await user.click(await screen.findByRole("option", { name: "Unread" }));

    // "Nothing here" means something different per filter, so the copy changes.
    expect(await screen.findByText(/no unread notifications/i)).toBeInTheDocument();
  });

  it("shows a failure state instead of an empty list when the request fails", async () => {
    renderWithProviders(<NotificationsPage />, {
      routes: {
        ...routes(["/notifications/unread-count", { unreadCount: 0 }]),
        "/notifications?": () =>
          Promise.resolve(
            jsonResponse({ error: { code: "internal_error", message: "nope" } }, 500),
          ),
      },
    });

    expect(await screen.findByText(/could not load notifications/i)).toBeInTheDocument();
    // Crucially not "no notifications yet" - a failed request is not an empty one.
    expect(screen.queryByText(/no notifications yet/i)).toBeNull();
  });

  it("marks a notification read when its row is activated", async () => {
    const user = userEvent.setup();

    const { fetchMock } = renderWithProviders(<NotificationsPage />, {
      routes: stubList({
        default: { ...pageOf([makeNotification({ id: "n-1", link: "/preferences" })]), nextCursor: null },
        // Anything not the list or the count.
        "/read": () => Promise.resolve(jsonResponse({ updated: 1 })),
      }),
    });

    await screen.findByText("Ada assigned you a task");

    await user.click(screen.getByRole("link", { name: /ada assigned you a task/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/n-1/read"));

      expect(calls).toHaveLength(1);
      expect(calls[0][1].method).toBe("PATCH");
    });
  });
});