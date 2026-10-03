/**
 * A guard that renders nothing while it decides.
 *
 * Issue #26 says an expired token must be handled "without the app crashing", and
 * the failure mode to avoid is the flash: signed-out UI rendering for one frame
 * before the token check completes, then swapping to signed-in. So the decision
 * happens before any route content is returned rather than inside each screen.
 */

import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/auth/auth-context";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isSignedIn, isChecking } = useAuth();
  const location = useLocation();

  // A token exists but has not been verified yet. Rendering anything now would
  // either flash the wrong screen or leak cached content from a previous user.
  if (isChecking) {
    return (
      <div className="space-y-4 p-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your session</span>

        <Skeleton className="h-8 w-48" />

        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!isSignedIn) {
    // `state.from` is what lets the user land back where they were trying to go,
    // instead of on the home page wondering why they were moved.
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}