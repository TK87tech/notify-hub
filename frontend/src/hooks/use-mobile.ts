import * as React from "react"

const MOBILE_BREAKPOINT = 768

const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Subscribes to the mobile breakpoint.
 *
 * Uses useSyncExternalStore rather than useState plus a useEffect. The previous
 * version set state inside the effect body, which renders the desktop sidebar
 * for one frame before correcting itself, and re-runs that extra render on every
 * mount. useSyncExternalStore is built for exactly this - reading an external
 * store like matchMedia - and gives a correct first render with no effect.
 */
export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    React.useCallback((onStoreChange: () => void) => {
      const mql = window.matchMedia(query)

      mql.addEventListener("change", onStoreChange)

      return () => mql.removeEventListener("change", onStoreChange)
    }, []),
    () => window.matchMedia(query).matches,
    // Server snapshot: assume desktop, which is the wider layout and so the
    // safer default for content that must not overflow.
    () => false,
  )
}