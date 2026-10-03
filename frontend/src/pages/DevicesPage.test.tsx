/**
 * Issue #25 / #31, browser push opt-in.
 *
 * The ordering is the feature: permission, then a subscription, then
 * registration with the API. Every wrong ordering looks identical from outside -
 * the button ends up on and nothing is ever delivered - so these tests assert
 * the calls that happened and the order between them, not just the final wording.
 *
 * `VITE_VAPID_PUBLIC_KEY` is read at module scope, and the two cases here need it
 * both present and absent. Each test therefore resets the module registry and
 * re-imports the page *and* the harness together, so they land in the same fresh
 * module graph - importing the page alone would give it a second copy of React
 * Query's context, and `useQueryClient()` would throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const VAPID = "BOq0-example-vapid-key-value_1234567";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

/** Pinned so `detectPlatform()` is deterministic - jsdom otherwise reports the
 * host, which made this pass on Windows and fail on the Linux runner. */
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120";

interface Loaded {
  Page: React.ComponentType;
  render: typeof import("@/test/render").renderWithProviders;
}

async function load(vapid: string): Promise<Loaded> {
  vi.resetModules();
  // Empty string rather than deleting, because stubEnv takes a string and an
  // empty one is falsy - which is exactly the "not configured" case.
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", vapid);

  const [page, harness] = await Promise.all([
    import("@/pages/DevicesPage"),
    import("@/test/render"),
  ]);

  return { Page: page.default, render: harness.renderWithProviders };
}

/**
 * jsdom has no Notifications API or service worker, so both are supplied.
 *
 * `current` and `outcome` are separate because they are different things: what
 * the page reads on mount, and what the user then decides when prompted.
 */
function stubBrowser(current: NotificationPermission, outcome: NotificationPermission = current) {
  const requestPermission = vi.fn().mockResolvedValue(outcome);
  const subscribe = vi.fn().mockResolvedValue({ endpoint: ENDPOINT });

  vi.stubGlobal("Notification", { permission: current, requestPermission });

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { subscribe } }) },
  });

  Object.defineProperty(navigator, "userAgent", { configurable: true, value: WINDOWS_UA });

  return { requestPermission, subscribe };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("DevicesPage", () => {
  it("says so plainly when the browser cannot do push at all", async () => {
    const { Page, render } = await load(VAPID);

    // No Notification global: the `in` check must fail, not throw.
    vi.stubGlobal("Notification", undefined);
    Reflect.deleteProperty(window, "Notification");

    render(<Page />, { routes: {} });

    expect(screen.getByText(/not available in this browser/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable push/i })).not.toBeInTheDocument();
  });

  it("refuses to enable when the deployment has no VAPID key", async () => {
    const { Page, render } = await load("");
    const { subscribe } = stubBrowser("default");

    render(<Page />, { routes: {} });

    expect(screen.getByRole("button", { name: /enable push/i })).toBeDisabled();
    expect(screen.getByText(/no VITE_VAPID_PUBLIC_KEY/i)).toBeInTheDocument();
    // Nothing was attempted, so nothing may have been registered.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("explains a blocked permission instead of offering a button that cannot work", async () => {
    const { Page, render } = await load(VAPID);
    stubBrowser("denied");

    render(<Page />, { routes: {} });

    expect(screen.getByText(/blocking notifications for this site/i)).toBeInTheDocument();

    // The browser will not prompt again, so the button is a dead end.
    expect(screen.getByRole("button", { name: /enable push/i })).toBeDisabled();
  });

  it("registers the subscription only after permission is granted", async () => {
    const user = userEvent.setup();
    const { Page, render } = await load(VAPID);
    // Not yet asked, then granted when prompted.
    const { requestPermission, subscribe } = stubBrowser("default", "granted");

    const { fetchMock } = render(<Page />, {
      routes: { "/devices": () => Promise.resolve({ ok: true, status: 201, json: async () => ({}) } as Response) },
    });

    await user.click(screen.getByRole("button", { name: /enable push/i }));

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/push is on for this device/i)).toBeInTheDocument());

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      // Raw bytes, not base64: the API expects a Uint8Array here.
      applicationServerKey: expect.any(Uint8Array),
    });

    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/devices"));

    expect(calls).toHaveLength(1);
    expect(calls[0][1].method).toBe("POST");
    // `windows` follows from the pinned UA, which is what lets this assertion hold
    // on the Linux runner as well as locally.
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ token: ENDPOINT, platform: "windows" });
  });

  it("does not claim success when permission is refused", async () => {
    const user = userEvent.setup();
    const { Page, render } = await load(VAPID);
    const { subscribe } = stubBrowser("default", "denied");

    const { fetchMock } = render(<Page />, { routes: {} });

    await user.click(screen.getByRole("button", { name: /enable push/i }));

    await waitFor(() => expect(screen.getByText(/blocking notifications for this site/i)).toBeInTheDocument());

    // The trap: subscribing and registering anyway, then saying "on".
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/devices"))).toHaveLength(0);
    expect(screen.queryByText(/push is on for this device/i)).toBeNull();
  });

  it("does not claim success when registration with the API fails", async () => {
    const user = userEvent.setup();
    const { Page, render } = await load(VAPID);
    stubBrowser("granted");

    render(<Page />, {
      routes: {
        "/devices": () =>
          Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: { code: "internal_error", message: "nope" } }),
          } as Response),
      },
    });

    await user.click(screen.getByRole("button", { name: /enable push/i }));

    // The subscription exists, but the API never accepted it - so the device is
    // still not registered and the UI must not say it is. The message shown is
    // the server's, because that is the part the user can act on.
    expect(await screen.findByText(/push is off for this device/i)).toBeInTheDocument();
    expect(screen.getByText("nope")).toBeInTheDocument();
  });

  it("locks the button once push is on", async () => {
    const user = userEvent.setup();
    const { Page, render } = await load(VAPID);
    stubBrowser("granted");

    render(<Page />, {
      routes: { "/devices": () => Promise.resolve({ ok: true, status: 201, json: async () => ({}) } as Response) },
    });

    await user.click(screen.getByRole("button", { name: /enable push/i }));

    await waitFor(() => expect(screen.getByText(/push is on for this device/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /enable push/i })).toBeDisabled();
  });
});