/**
 * The header bell and its panel. Issue #22.
 *
 * The badge is the part worth arguing about. It has to be right in three
 * situations that pull in opposite directions: on first paint, when the count has
 * not loaded yet and rendering "0" would be a lie; when the count is genuinely
 * zero, when the badge must be absent rather than showing a red "0"; and when a
 * live push arrives, when the number has to move without a refetch. So the badge
 * renders only once a count exists and only when it is above zero.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCheck } from "lucide-react";

import { NotificationIcon } from "@/components/shared/NotificationIcon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/shared/EmptyState";
import { NotificationRow } from "@/features/notifications/NotificationRow";
import { NotificationListSkeleton } from "@/features/notifications/NotificationListSkeleton";
import { useMarkAllRead, useNotifications, useUnreadCount } from "@/api/hooks";

/** Rows fetched for the panel. Kept small; the full page exists for the rest. */
const PANEL_LIMIT = 8;

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const markAll = useMarkAllRead();

  // `isPending` rather than `isLoading`: while fetching, a stale count is better
  // than none, and flipping the badge to invisible on every background refetch
  // reads as "you have nothing new", which is worse than being a few seconds late.
  const count = unread.data?.unreadCount;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* NotificationIcon is itself a real button and already names itself
            ("3 unread notifications"), so it is the correct trigger element.
            Rendering a span here would nest one interactive element inside
            another and cost keyboard access. */}
        <PopoverTrigger render={<NotificationIcon unreadCount={count ?? 0} />} />

      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!count || markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck className="size-3.5" />

            {markAll.isPending ? "Marking…" : "Mark all read"}
          </Button>
        </div>

        <Separator />

        {/* Mounted only while open. Fetching the panel's rows eagerly would cost
            a request on every page load for a panel nobody opened. */}
        {open && <NotificationPanelBody onNavigate={() => setOpen(false)} />}

        <Separator />

        <div className="p-2">
          <Button variant="ghost" size="sm" className="w-full text-xs" render={<Link to="/" />}>
            View all notifications
          </Button>
        </div>
      </PopoverContent>

      {/* Outside the trigger, because the trigger is a button and a live region
          inside it would be re-announced on every badge change. */}
      {unread.isPending && count === undefined && (
        <span className="sr-only" role="status">
          Loading unread count
        </span>
      )}
    </Popover>
  );
}

function NotificationPanelBody({ onNavigate }: { onNavigate: () => void }) {
  const list = useNotifications({ limit: PANEL_LIMIT });

  if (list.isPending) return <NotificationListSkeleton rows={PANEL_LIMIT} />;

  if (list.isError) {
    return (
      <div className="p-4">
        <EmptyState
          title="Could not load notifications"
          description="Check your connection and try again."
        />
      </div>
    );
  }

  const rows = list.data?.pages[0]?.items ?? [];

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="You are all caught up"
          description="New notifications will appear here as they arrive."
        />
      </div>
    );
  }

  return (
    <ScrollArea className="max-h-96">
      <ul>
        {rows.map((notification) => (
          <li key={notification.id}>
            <NotificationRow
              notification={notification}
              onNavigate={onNavigate}
              showTimestamp
            />
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}