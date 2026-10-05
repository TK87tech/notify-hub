/**
 * Service worker registration. Issue #25.
 *
 * This is the missing half of browser push, and it is missing in a way that is
 * easy to miss: `DevicesPage` awaits `navigator.serviceWorker.ready` before it
 * subscribes, and that promise never resolves unless something has *registered*
 * a worker for this scope. Without a call to `register()` the page hangs on a
 * promise instead of erroring, so the opt-in button just spins forever and
 * nothing in the test suite notices - the tests stub `ready` directly.
 *
 * Registration happens here at startup rather than on the push page so that
 * `ready` is already settled by the time somebody clicks Enable.
 */

/** Root scope, because the app is served from the root of its domain. */
// Follow Vite's base, so a build served from a subpath registers its own worker.
const SW_URL = `${import.meta.env.BASE_URL}sw.js`;
const SW_SCOPE = import.meta.env.BASE_URL;

export type RegisterOutcome =
  /** A worker was registered and is installing. */
  | "registered"
  /** Already had one. Nothing to do. */
  | "already-registered"
  /** This browser has no service worker support. */
  | "unsupported"
  /** Not a production build. See below. */
  | "skipped"
  /** `register()` threw. The app still works. */
  | "failed";

/**
 * Registers the push worker, if this build should have one.
 *
 * Never throws and never rejects: a push delivery that cannot be set up is not
 * worth taking the app down for, and the caller has no useful way to recover.
 */
export async function registerServiceWorker(): Promise<RegisterOutcome> {
  if (!("serviceWorker" in navigator)) return "unsupported";

  // A worker in development caches the entry point and the dev server's module
  // graph, which produces a tab serving a stale build with no obvious cause. Vite
  // serves modules that a worker is not meant to manage. So: production only.
  if (!import.meta.env.PROD) return "skipped";

  try {
    const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);

    if (existing?.active) return "already-registered";

    await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });

    return "registered";
  } catch (err) {
    // Almost always an https-on-localhost mistake, which the console message
    // explains far better than this one could.
    console.warn("[push] service worker registration failed", err);

    return "failed";
  }
}