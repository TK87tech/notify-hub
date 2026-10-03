import type { ComponentProps } from "react";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface NotificationIconProps extends ComponentProps<typeof Button> {
  unreadCount?: number;
}

/**
 * The bell and its unread badge.
 *
 * Accepts and forwards every Button prop, which it must do because this is
 * rendered as a `render` target by PopoverTrigger. A version that swallowed its
 * props looked correct on screen but silently dropped the trigger's click
 * handler, ref and aria-expanded - so the popover could never open and no
 * assistive technology could tell it was a menu.
 *
 * The badge is omitted entirely at zero rather than rendered as a red "0":
 * a zero unread count is the absence of news, and a badge implies something
 * needs attention.
 */
export function NotificationIcon({ unreadCount = 0, ...props }: NotificationIconProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      {...props}
      // After the spread: the count belongs in the accessible name, and a value
      // arriving from a generic prop spread must not overwrite it.
      aria-label={
        unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"
      }
    >
      <Bell />

      {unreadCount > 0 && (
        <Badge
          variant="destructive"
          // Presentational only - the number is already in the aria-label, so
          // announcing it twice would be noise.
          aria-hidden="true"
          className="absolute -right-1 -top-1 min-w-5 h-5 px-1 text-xs"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </Badge>
      )}
    </Button>
  );
}