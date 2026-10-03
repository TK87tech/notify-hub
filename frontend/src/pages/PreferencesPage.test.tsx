/**
 * Issue #24 / #31, preferences.
 *
 * The assertions concentrate on the two shapes the contract is easy to get wrong
 * and that fail silently rather than loudly:
 *
 *   - `channels` is a map keyed by notification type, so toggling one channel
 *     must leave the other two for that type alone.
 *   - `quietHours` is nullable with no `enabled` flag, so switching it off has to
 *     send `null` - sending `{enabled: false}` would be a field the API does not
 *     declare, which is a 400 rather than a visible mistake in the UI.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import PreferencesPage from "@/pages/PreferencesPage";
import type { Preferences } from "@/api/types";
import {
  jsonResponse,
  renderWithProviders,
  routes,
  type Routes,
} from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture(): Preferences {
  return {
    channels: {
      task_assigned: { inApp: true, email: true, push: false },
      payment_received: { inApp: true, email: false, push: false },
      deadline_warning: { inApp: true, email: true, push: true },
      comment: { inApp: true, email: false, push: false },
      system: { inApp: true, email: false, push: false },
    },
    quietHours: null,
  };
}

/** The zone this machine reports, so the expectation is not machine-specific. */
function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The switch control for one type/channel pair.
 *
 * Looked up via the hidden checkbox's id, then resolved to the `role="switch"`
 * element beside it: Base UI puts the id on the hidden input (the form-control
 * target for the label) and the accessible state on the sibling span. Asserting
 * on the input would test an `aria-hidden` node, and asserting by label would
 * match five elements, one per notification type.
 */
function switchFor(type: string, channel: string): HTMLElement {
  const input = document.getElementById(`${type}-${channel}`);

  if (!input) throw new Error(`no switch for ${type}.${channel}`);

  const control = input.parentElement?.querySelector<HTMLElement>('[role="switch"]');

  if (!control) throw new Error(`no role=switch for ${type}.${channel}`);

  return control;
}

function isOn(type: string, channel: string): boolean {
  return switchFor(type, channel).getAttribute("aria-checked") === "true";
}

function prefsStubs(overrides: Routes = {}): Routes {
  return { ...routes(["/preferences", fixture()]), ...overrides };
}

/** A stub that answers the GET with `data` and echoes any PUT back, as the API does. */
function echoOnSave(data: Preferences): Routes {
  return {
    "/preferences": (_url, init) => {
      if (init?.method !== "PUT") return Promise.resolve(jsonResponse(data));

      // Echoing is what makes `isDirty` settle afterwards; returning a stub like
      // `{ok: true}` would replace the cached preferences with a shape that has
      // no `channels` map at all.
      return Promise.resolve(jsonResponse(JSON.parse(String(init.body))));
    },
  };
}

/** The JSON body of the last PUT to /preferences. */
function savedBody(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): Preferences {
  const calls = fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes("/preferences") && init?.method === "PUT",
  );

  expect(calls, "no PUT was sent").not.toHaveLength(0);

  return JSON.parse(String(calls[calls.length - 1][1]?.body));
}

function putCalls(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes("/preferences") && init?.method === "PUT",
  );
}

/** CardTitle renders a div, so the page's real landmark is the page heading. */
async function renderLoaded(overrides: Routes = {}) {
  const rendered = renderWithProviders(<PreferencesPage />, { routes: prefsStubs(overrides) });

  await screen.findByText("Quiet hours");

  return rendered;
}

describe("PreferencesPage", () => {
  it("renders a control for every notification type and channel", async () => {
    await renderLoaded();

    for (const type of Object.keys(fixture().channels)) {
      for (const channel of ["inApp", "email", "push"]) {
        expect(switchFor(type, channel), `${type}.${channel}`).toBeInTheDocument();
      }
    }
  });

  it("labels every switch", async () => {
    await renderLoaded();

    // Five notification types, so three each. What matters is that the label's
    // `for` - which points at a hidden input - still reaches the visible
    // `role="switch"` element.
    for (const channel of ["In-app", "Email", "Push"]) {
      expect(screen.getAllByRole("switch", { name: channel })).toHaveLength(5);
    }

    expect(screen.getByRole("switch", { name: /enable quiet hours/i })).toBeInTheDocument();
  });

  it("PUTs the whole preferences object, changing only the channel that moved", async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderLoaded(echoOnSave(fixture()));

    expect(isOn("task_assigned", "push")).toBe(false);

    await user.click(switchFor("task_assigned", "push"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));

    const { channels } = savedBody(fetchMock);

    expect(channels.task_assigned).toEqual({ inApp: true, email: true, push: true });
    // The trap: replacing the ChannelSet wholesale would have reset these.
    expect(channels.payment_received).toEqual(fixture().channels.payment_received);
    expect(channels.system).toEqual(fixture().channels.system);
  });

  it("does not write until Save is pressed", async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderLoaded(echoOnSave(fixture()));

    await user.click(switchFor("comment", "email"));

    // Per-keystroke writes would be a dozen requests per slider drag.
    expect(putCalls(fetchMock)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
  });

  it("sends null - not an enabled flag - when quiet hours are switched off", async () => {
    const user = userEvent.setup();
    const withQuietHours: Preferences = {
      ...fixture(),
      quietHours: { start: "22:00", end: "07:00", timezone: "UTC" },
    };

    const { fetchMock } = await renderLoaded(echoOnSave(withQuietHours));

    const toggle = screen.getByRole("switch", { name: /enable quiet hours/i });

    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));

    // `{enabled: false}` is not in the schema; `null` is how you turn this off.
    expect(savedBody(fetchMock).quietHours).toBeNull();
  });

  it("creates a complete window when quiet hours are switched on", async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderLoaded(echoOnSave(fixture()));

    await user.click(screen.getByRole("switch", { name: /enable quiet hours/i }));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));

    // All three fields, because two blank time inputs would be sent straight back.
    expect(savedBody(fetchMock).quietHours).toEqual({
      start: "22:00",
      end: "07:00",
      timezone: localZone(),
    });
  });

  it("keeps edits on screen after a failed save", async () => {
    const user = userEvent.setup();

    await renderLoaded({
      "/preferences": (_url, init) =>
        init?.method === "PUT"
          ? Promise.resolve(
              jsonResponse({ error: { code: "internal_error", message: "nope" } }, 500),
            )
          : Promise.resolve(jsonResponse(fixture())),
    });

    await user.click(switchFor("system", "push"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // The user has to be able to try again, so the draft must survive the error.
    await waitFor(() => expect(screen.getByText(/could not save preferences/i)).toBeInTheDocument());
    expect(isOn("system", "push")).toBe(true);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("reverts the draft when Discard is pressed", async () => {
    const user = userEvent.setup();

    await renderLoaded();

    await user.click(switchFor("comment", "push"));

    expect(isOn("comment", "push")).toBe(true);
    expect(screen.getByRole("button", { name: /discard/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /discard/i }));

    expect(isOn("comment", "push")).toBe(false);
    // Nothing to save once the draft matches the server again.
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });

  it("disables Save until something changes", async () => {
    await renderLoaded();

    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /discard/i })).toBeDisabled();
  });

  it("shows an empty state rather than a broken form when the load fails", async () => {
    renderWithProviders(<PreferencesPage />, {
      routes: {
        "/preferences": () =>
          Promise.resolve(
            jsonResponse({ error: { code: "internal_error", message: "nope" } }, 500),
          ),
      },
    });

    expect(await screen.findByText(/could not load preferences/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
  });

  it("reports a successful save", async () => {
    const user = userEvent.setup();

    await renderLoaded(echoOnSave(fixture()));

    await user.click(switchFor("system", "push"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // Once saved, the draft matches the server, so Save is correctly inert.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled(),
    );
  });
});

describe("PreferencesPage contract shape", () => {
  it("reads a preferences payload shaped as a per-type map", async () => {
    // Guards the other direction: if the page assumed a single
    // `{inApp,email,push}` triple, the server's real response would render
    // every toggle as off without a single error.
    renderWithProviders(<PreferencesPage />, {
      routes: routes(["/preferences", fixture()]),
    });

    await screen.findByText("Quiet hours");

    expect(isOn("task_assigned", "inApp")).toBe(true);
    expect(isOn("task_assigned", "push")).toBe(false);
  });

  it("renders a type the payload omits without losing the known ones", async () => {
    const partial = fixture();

    delete (partial.channels as Partial<typeof partial.channels>).comment;

    renderWithProviders(<PreferencesPage />, {
      routes: routes(["/preferences", partial]),
    });

    await screen.findByText("Quiet hours");

    // Present but off, rather than crashing on a missing key.
    expect(isOn("comment", "inApp")).toBe(false);
    expect(isOn("task_assigned", "email")).toBe(true);
  });
});