/**
 * The full notification list. Issue #25.
 *
 * Shares NotificationRow with the panel so a notification cannot look different
 * in the two places - if they diverged, the panel would stop being a preview of
 * this page and become a second, subtly wrong implementation.
 */

import { useState } from "react";
import { CheckCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/EmptyState";
import { NotificationRow } from "@/features/notifications/NotificationRow";
import { NotificationListSkeleton } from "@/features/notifications/NotificationListSkeleton";
import { useMarkAllRead, useNotifications } from "@/api/hooks";
import type { NotificationStatusFilter } from "@/api/types";

/** Page size chosen so the first screenful rarely needs a second request. The
 * API caps `limit` at 50. */
const PAGE_SIZE = 20;

/** The API accepts only `all` and `unread`; there is no `read` filter. */
const STATUS_OPTIONS: { value: NotificationStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

export default function NotificationsPage() {
  const [status, setStatus] = useState<NotificationStatusFilter>("all");
  const markAll = useMarkAllRead();

  const list = useNotifications({ limit: PAGE_SIZE, status });
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="space-y-4" aria-labelledby="notifications-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="notifications-heading" className="text-lg font-semibold">
            Notifications
          </h2>

          <p className="text-sm text-muted-foreground">
            Everything sent to you across email, push and in-app.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={(value) => setStatus(value as NotificationStatusFilter)}>
            <SelectTrigger className="w-32" aria-label="Filter by read status">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={markAll.isPending || rows.every((row) => row.read)}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck className="size-4" />

            Mark all read
          </Button>
        </div>
      </div>

      <Separator />

      {list.isPending ? (
        <NotificationListSkeleton rows={PAGE_SIZE / 2} />
      ) : list.isError ? (
        <EmptyState
          title="Could not load notifications"
          description="We couldn't reach the server. Check your connection and try again."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={status === "unread" ? "No unread notifications" : "No notifications yet"}
          description={
            status === "unread"
              ? "You have read everything. Switch to All to see your history."
              : "Notifications sent to you will appear here."
          }
        />
      ) : (
        <>
          <ul className="divide-y rounded-md border">
            {rows.map((notification) => (
              <li key={notification.id}>
                <NotificationRow notification={notification} />
              </li>
            ))}
          </ul>

          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}