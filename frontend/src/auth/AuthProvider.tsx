/**
 * Who is signed in, and what happens when that stops being true.
 *
 * The actual expiry handling lives in api/query-client.ts, because a 401 can
 * arrive on any request and only one place should decide what that means. This
 * provider's job is narrower: hold the signed-in user, expose sign-in and
 * sign-out, and re-render when the query client says the session ended.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ApiError } from "@/api/client";
import { signIn as signInRequest, signUp as signUpRequest, type SignUpInput } from "@/api/endpoints";
import type { Session } from "@/api/types";
import { queryKeys } from "@/api/query-keys";
import { onSignedOut } from "@/api/query-client";
import { clearToken, hasUsableToken, writeToken } from "@/api/token";
import { AuthContext, type AuthValue } from "./auth-context";
import { useSession } from "@/api/hooks";

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSession();

  // Set by the global 401 handler. A token can die on a background refetch long
  // after the session probe succeeded, and nothing else would re-render this
  // provider to notice.
  const [revoked, setRevoked] = useState(false);

  // Subscribing rather than importing the listener directly keeps the global
  // handler in api/ from having to know about this component.
  useEffect(
    () =>
      onSignedOut(() => {
        setRevoked(true);
      }),
    [],
  );

  const signOut = useCallback(() => {
    clearToken();
    setRevoked(true);
    queryClient.clear();
  }, [queryClient]);

  // Shared by sign-in and sign-up: both answer with a Session.
  const startSession = useCallback(
    (result: Session) => {
      writeToken(result.token);
      setRevoked(false);
      queryClient.setQueryData(queryKeys.session, result.user);
    },
    [queryClient],
  );

  const signUp = useCallback(
    async (input: SignUpInput) => {
      startSession(await signUpRequest(input));
    },
    [startSession],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await signInRequest(email, password);

      writeToken(result.token);
      setRevoked(false);

      // Seeded from the sign-in response rather than refetched: the response
      // already carries the user, and an immediate extra request is a second
      // chance to fail on a flaky connection right after somebody typed a
      // correct password.
      queryClient.setQueryData(queryKeys.session, result.user);
    },
    [queryClient],
  );

  // Recomputed each render rather than stored, because localStorage is the source
  // of truth and the global 401 handler writes to it from outside React. `revoked`
  // covers the window where the token has not been cleared but is already known
  // to be bad.
  const hasToken = hasUsableToken();
  const rejected = session.error instanceof ApiError && session.error.isUnauthorized;
  const isSignedIn = hasToken && !revoked && !rejected;

  const value = useMemo<AuthValue>(
    () => ({
      user: isSignedIn ? (session.data ?? null) : null,
      isChecking: hasToken && session.isPending,
      isSignedIn,
      signIn,
      signUp,
      signOut,
    }),
    [hasToken, isSignedIn, session.data, session.isPending, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}