/**
 * The shared QueryClient.
 *
 * The one non-obvious thing here is the global 401 handler. Issue #26 asks for an
 * expired token to be handled "without the app crashing", and a token can expire
 * at any moment - so it is not enough for the sign-in screen to notice. Any
 * query or mutation can be the one that discovers the token is dead, including a
 * background refetch of the unread count on a tab that has been open for hours.
 *
 * Catching it here rather than per screen is the difference between one place
 * that ends the session and eleven call sites that each have to remember to.
 */

import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query";

import { ApiError } from "./client";
import { clearToken } from "./token";

/** Called by AuthProvider so a rejected token re-renders the tree. */
type SignOutListener = () => void;

let notifySignedOut: SignOutListener | null = null;

/**
 * Registers the single listener that re-renders the auth provider.
 *
 * Returns an unsubscribe function rather than nothing, because the provider
 * registers from a `useEffect` whose cleanup runs on every StrictMode
 * double-invoke. Without a real teardown, a remounted provider leaves the first
 * one's listener attached and a revoked token fires setState on an unmounted
 * component.
 */
export function onSignedOut(listener: SignOutListener): () => void {
  notifySignedOut = listener;

  return () => {
    if (notifySignedOut === listener) notifySignedOut = null;
  };
}

function handleRejectedToken(error: unknown): void {
  if (!(error instanceof ApiError) || !error.isUnauthorized) return;

  clearToken();

  // The token is gone, so every cached response belongs to a session that no
  // longer exists. Not clearing them would show the previous user's
  // notifications to whoever signs in next on a shared machine.
  queryClient.clear();

  notifySignedOut?.();
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleRejectedToken }),
  mutationCache: new MutationCache({ onError: handleRejectedToken }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Retrying a 401 just produces more 401s. Retrying a 400 repeats a
        // request the server has already rejected on its merits.
        if (error instanceof ApiError && (error.isUnauthorized || error.isValidation)) {
          return false;
        }

        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});