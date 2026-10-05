import { createContext, useContext } from "react";

import type { User } from "@/api/types";
import type { SignUpInput } from "@/api/endpoints";

export interface AuthValue {
  user: User | null;
  /** True while a stored token is being verified against the API. */
  isChecking: boolean;
  isSignedIn: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  /** Creates the account, then leaves the browser signed in as it. */
  signUp: (input: SignUpInput) => Promise<void>;
  signOut: () => void;
}

/**
 * The context lives in its own module, away from the provider component.
 *
 * react-refresh can only fast-refresh a file that exports nothing but
 * components, and co-locating the hook with the provider means editing AuthProvider
 * always invalidates every screen that imports useAuth - so the whole app
 * remounts during development instead of hot-reloading.
 */
export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);

  // Throwing beats returning null: a missing provider is a wiring bug that should
  // be loud during development, not a null dereference on the first render of a
  // page that happens to read isSignedIn.
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider");
  }

  return value;
}