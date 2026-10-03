import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder while a lazily loaded route is fetched.
 *
 * Matches the shape of the page it replaces rather than spinning a centred
 * spinner, so the content does not jump when the chunk arrives. `aria-busy` plus
 * the screen-reader-only line mean assistive technology is told what is happening
 * instead of being handed an apparently empty page.
 */
export function RouteFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading page</span>

      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}