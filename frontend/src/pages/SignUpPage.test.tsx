import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SignUpPage from "@/pages/SignUpPage";
import { readToken } from "@/api/token";
import { jsonResponse, renderWithProviders, routes, sessionResponse } from "@/test/render";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  { email = "ada@example.com", password = "long-enough-pw", confirm }: { email?: string; password?: string; confirm?: string } = {},
) {
  confirm ??= password;
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.type(screen.getByLabelText("Confirm password"), confirm);
  await user.click(screen.getByRole("button", { name: "Create account" }));
}

const signUpCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("auth/sign-up"));

describe("SignUpPage", () => {
  it("creates the account and stores the session token", async () => {
    const user = userEvent.setup();
    const session = sessionResponse();
    const { fetchMock } = renderWithProviders(<SignUpPage />, {
      signedIn: false,
      routes: routes(["/auth/sign-up", session]),
    });

    await fill(user);

    await waitFor(() => expect(readToken()).toBe(session.token));

    const [call] = signUpCalls(fetchMock);
    expect(JSON.parse(String(call[1].body))).toEqual({
      email: "ada@example.com",
      password: "long-enough-pw",
    });
  });

  it("catches a short or mismatched password without a round trip", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<SignUpPage />, {
      signedIn: false,
      routes: routes(["/auth/sign-up", sessionResponse()]),
    });

    await fill(user, { password: "short", confirm: "different" });

    expect(await screen.findByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("The passwords do not match.")).toBeInTheDocument();
    expect(signUpCalls(fetchMock)).toHaveLength(0);
  });

  it("announces a taken email from the server", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignUpPage />, {
      signedIn: false,
      routes: {
        "/auth/sign-up": () =>
          Promise.resolve(
            jsonResponse(
              { error: { code: "conflict", message: "An account with that email already exists. Sign in instead." } },
              409,
            ),
          ),
      },
    });

    await fill(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/);
    expect(readToken()).toBeNull();
  });
});
