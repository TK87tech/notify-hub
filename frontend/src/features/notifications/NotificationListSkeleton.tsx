import { Skeleton } from "@/components/ui/skeleton";

/**
 * Matches the row layout closely enough that the list does not visibly jump when
 * real data replaces it. A generic grid of bars here would make every load look
 * like a layout shift.
 */
export function NotificationListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="divide-y" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <li key={index} className="flex gap-3 px-4 py-3">
          <Skeleton className="size-4 shrink-0 rounded-sm" />

          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </li>
      ))}
    </ul>
  );
}