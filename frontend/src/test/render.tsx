/**
 * Test rendering with the real providers.
 *
 * The providers under test here - AuthProvider, the query client, the router -
 * are exactly where the bugs that matter live, so the harness uses the real ones
 * rather than mocks. What is faked is only the network boundary, because that is
 * the one thing a unit test genuinely should not exercise.
 */

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";

import { ApiError } from "@/api/client";
import { AuthProvider } from "@/auth/AuthProvider";
import { RealtimeProvider } from "@/realtime/RealtimeProvider";
import { writeToken } from "@/api/token";
import type { Notification, Session, User } from "@/api/types";

/** A signed-in user, so tests do not each have to invent one. */
export const TEST_USER: User = { id: "user-1", email: "ada@example.com", name: "Ada" };

/** A JWT-shaped token with an hour left, so hasUsableToken() passes. */
export function validToken(): string {
  const payload = btoa(JSON.stringify({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `header.${payload}.sig`;
}

/**
 * A fresh QueryClient per test.
 *
 * Reusing the module-level client would leak cached notifications between tests,
 * and the failure mode is a test that passes because of data left behind by the
 * previous one. Retries are off so a deliberately failing request fails once.
 */
function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    type: "task_assigned",
    title: "Ada assigned you a task",
    body: "Design review",
    link: null,
    priority: "normal",
    read: false,
    createdAt: new Date().toISOString(),
    data: {},
    ...overrides,
  };
}

export interface HarnessOptions extends Omit<RenderOptions, "wrapper"> {
  /** Signs in before rendering, so the guard lets the page through. */
  signedIn?: boolean;
  /** Skips RealtimeProvider for tests that are not about the socket. */
  withRealtime?: boolean;
  /** Starting route. */
  route?: string;
  /**
   * Endpoints to stub, keyed by a URL substring.
   *
   * Supplied as an option rather than returned for later configuration, because
   * the first query fires during the initial render - registering a stub after
   * that has already been requested means the component sees a 404 and settles
   * into its error state before the test has finished setting up.
   */
  routes?: Routes;
}

export type Routes = Record<string, (url: string, init?: RequestInit) => Promise<Response>>;

/** Builds a stub map from `[substring, body]` pairs. */
export function routes(...pairs: [string, unknown][]): Routes {
  const map: Routes = {};

  for (const [suffix, body] of pairs) map[suffix] = () => Promise.resolve(jsonResponse(body));

  return map;
}

/** Builds a stub map that fails every listed endpoint. */
export function failingRoutes(status: number, ...suffixes: string[]): Routes {
  const map: Routes = {};
  const body = { error: { code: status === 401 ? "unauthorized" : "internal_error", message: "boom" } };

  for (const suffix of suffixes) map[suffix] = () => Promise.resolve(jsonResponse(body, status));

  return map;
}

/**
 * Renders `ui` inside the production provider stack, with `fetch` stubbed.
 */
export function renderWithProviders(
  ui: ReactElement,
  { signedIn = true, withRealtime = false, route = "/", routes: stubs = {}, ...options }: HarnessOptions = {},
): RenderResult & { fetchMock: ReturnType<typeof vi.fn>; queryClient: QueryClient } {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    // `init` is passed through so a stub can answer GET and PUT differently on
    // the same path - the preferences endpoint needs exactly that.
    for (const [suffix, responder] of Object.entries(stubs)) {
      if (url.includes(suffix)) return responder(url, init);
    }

    return Promise.resolve(
      jsonResponse({ error: { code: "not_found", message: `no stub for ${url}` } }, 404),
    );
  });

  vi.stubGlobal("fetch", fetchMock);

  if (signedIn) writeToken(validToken());

  // Created once, outside the component. Calling makeClient() inside Wrapper
  // produced a new QueryClient on every render, so every consumer saw its cache
  // wiped and its query restarted - which on the 401 path is an infinite render
  // loop rather than a visible failure.
  const client = makeClient();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          {/* Sonner renders into its own portal, so without this a toast is
              fired and then asserted against DOM that does not exist. */}
          <Toaster />

          <AuthProvider>
            {/* Real routes, so a guard that redirects actually lands on a
                rendered sign-in screen instead of on nothing - which is both
                closer to the app and what makes the redirect assertable. */}
            <Routes>
              <Route path="/sign-in" element={<p>Sign in screen</p>} />

              <Route
                path="*"
                element={withRealtime ? <RealtimeProvider>{children}</RealtimeProvider> : children}
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper, ...options }), fetchMock, queryClient: client };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A page envelope, matching the contract's GET /notifications response. */
export function pageOf(items: Notification[], unreadCount?: number) {
  return { items, unreadCount: unreadCount ?? items.filter((item) => !item.read).length };
}

export function sessionResponse(): Session {
  return { token: validToken(), user: TEST_USER };
}

/** Builds an ApiError directly, for exercising error branches without a fetch. */
export function apiError(status: number, message = "boom"): ApiError {
  return new ApiError(status, status === 401 ? "unauthorized" : "internal_error", message);
}