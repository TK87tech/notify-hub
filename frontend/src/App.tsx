import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy, type ReactNode } from "react";

import { queryClient } from "@/api/query-client";
import { AuthProvider } from "@/auth/AuthProvider";
import { useAuth } from "@/auth/auth-context";
import { RealtimeProvider } from "@/realtime/RealtimeProvider";
import ProtectedRoute from "@/routes/ProtectedRoute";
import { AppShell } from "@/components/layout/AppShell";
import { RouteFallback } from "@/components/shared/RouteFallback";

/**
 * Split per route.
 *
 * Sign-in alone pulls in React Hook Form and Zod, and the push page pulls in the
 * subscription plumbing; none of that is needed to read notifications. Loading
 * each route as its own chunk took the entry bundle from well over a megabyte
 * to roughly half that.
 */
const SignInPage = lazy(() => import("@/pages/SignInPage"));
const NotificationsPage = lazy(() => import("@/pages/NotificationsPage"));
const PreferencesPage = lazy(() => import("@/pages/PreferencesPage"));
const DevicesPage = lazy(() => import("@/pages/DevicesPage"));

/**
 * Suspense boundary per route rather than one around <Routes>.
 *
 * Around <Routes> the first paint would suspend the shell too, so navigating to
 * preferences would blank the sidebar and header as well as the content. Here the
 * chrome stays put and only the panel shows the placeholder.
 */
function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Keeps a signed-in user off the sign-in page.
 *
 * Without this, visiting /sign-in while already authenticated shows a working
 * form that silently does nothing useful - the form succeeds, the navigation
 * goes to a page the user is already on, and there is no explanation.
 */
function SignInRoute() {
  const { isSignedIn, isChecking } = useAuth();

  if (isChecking) return null;
  if (isSignedIn) return <Navigate to="/" replace />;

  return <Page><SignInPage /></Page>;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          {/* Inside AuthProvider so the socket only connects while signed in,
              and inside BrowserRouter so a toast link can navigate. */}
          <RealtimeProvider>
            <Routes>
              <Route path="/sign-in" element={<SignInRoute />} />

              {/* Outlet rather than children: AppShell is a template component
                  with a fixed `children` prop, and the router fills it here so
                  the shell needs no knowledge of routing. */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell>
                      <Outlet />
                    </AppShell>
                  </ProtectedRoute>
                }
              >
                {/* `index` rather than a redirect so the home page has a real URL
                    to share and so a refresh does not depend on a redirect rule. */}
                <Route index element={<Page><NotificationsPage /></Page>} />
                <Route path="preferences" element={<Page><PreferencesPage /></Page>} />
                <Route path="devices" element={<Page><DevicesPage /></Page>} />
              </Route>

              {/* Anything unrecognised lands on the list rather than a dead end. */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RealtimeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}