/**
 * Issue #31, sign-in. Issue #30 partly: the global 401 path is covered in
 * `auth.test.tsx`, this file covers the form itself.
 *
 * These are the tests that would catch a credential ever being sent to, or read
 * from, the wrong place - so the assertions look at the request body rather than
 * at the button state, which would pass just as happily on a broken endpoint.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SignInPage from "@/pages/SignInPage";
import { readToken } from "@/api/token";
import {
  jsonResponse,
  renderWithProviders,
  routes,
  sessionResponse,
  TEST_USER,
} from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

function signInStubs() {
  return routes(["/auth/sign-in", sessionResponse()]);
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("SignInPage", () => {
  it("blocks an empty submit and never calls the API", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<SignInPage />, {
      signedIn: false,
      routes: signInStubs(),
    });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();

    const authCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("auth/sign-in"));

    expect(authCalls).toHaveLength(0);
  });

  it("rejects a malformed address without a round trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<SignInPage />, {
      signedIn: false,
      routes: signInStubs(),
    });

    await fillAndSubmit(user, "ada-at-example", "hunter2");

    expect(await screen.findByText("That is not an email address.")).toBeInTheDocument();

    const authCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("auth/sign-in"));

    expect(authCalls).toHaveLength(0);
  });

  it("marks invalid fields for assistive technology", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SignInPage />, { signedIn: false, routes: signInStubs() });

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const email = screen.getByLabelText("Email");

    await waitFor(() => expect(email).toHaveAttribute("aria-invalid", "true"));
    // aria-describedby must point at the message, or the error is invisible to
    // a screen reader even though it is on screen.
    expect(email.getAttribute("aria-describedby")).toBe("email-error");
    expect(document.getElementById("email-error")).toHaveTextContent("Enter your email address.");
  });

  it("posts the credentials and stores the returned token", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<SignInPage />, {
      signedIn: false,
      routes: signInStubs(),
    });

    await fillAndSubmit(user, TEST_USER.email, "correct horse");

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("auth/sign-in"));

      expect(calls).toHaveLength(1);
      expect(calls[0][1].method).toBe("POST");
      expect(JSON.parse(String(calls[0][1].body))).toEqual({
        email: TEST_USER.email,
        password: "correct horse",
      });
    });

    // The token has to survive the redirect, or the next load signs them out.
    await waitFor(() => expect(readToken()).not.toBeNull());
    expect(await screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces the server's rejection and stays signed out", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SignInPage />, {
      signedIn: false,
      routes: {
        "/auth/sign-in": () =>
          Promise.resolve(
            jsonResponse(
              { error: { code: "invalid_credentials", message: "Invalid email or password." } },
              401,
            ),
          ),
      },
    });

    await fillAndSubmit(user, TEST_USER.email, "wrong");

    // Announced, not merely painted: role="alert" is the whole point of the
    // check, since a silent failure is invisible to a screen reader user.
    const alert = await screen.findByRole("alert");

    // Verbatim, so the user sees what the API actually said.
    expect(alert).toHaveTextContent("Invalid email or password.");
    expect(readToken()).toBeNull();
  });

  it("distinguishes an unreachable server from a rejected login", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SignInPage />, { signedIn: false, routes: signInStubs() });

    // Offline after mount, which is the case a user actually hits in a lift.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await fillAndSubmit(user, TEST_USER.email, "correct horse");

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);
    expect(readToken()).toBeNull();
  });

  it("disables the button while the request is in flight", async () => {
    const user = userEvent.setup();

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    renderWithProviders(<SignInPage />, {
      signedIn: false,
      routes: {
        "/auth/sign-in": async () => {
          await pending;

          return { ok: true, status: 200, json: async () => sessionResponse() } as Response;
        },
      },
    });

    await fillAndSubmit(user, TEST_USER.email, "correct horse");

    // A second submit here would be a duplicate sign-in request.
    const button = await screen.findByRole("button", { name: "Signing in…" });

    expect(button).toBeDisabled();

    release?.();

    await waitFor(() => expect(readToken()).not.toBeNull());
  });
});