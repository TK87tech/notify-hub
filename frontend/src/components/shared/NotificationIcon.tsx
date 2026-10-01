import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface NotificationIconProps {
  unreadCount?: number;
}

export function NotificationIcon({ unreadCount = 0 }: NotificationIconProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={
        unreadCount > 0
          ? `${unreadCount} unread notifications`
          : "Notifications"
      }
    >
      <Bell />

      {unreadCount > 0 && (
        <Badge
          variant="destructive"
          className="absolute -right-1 -top-1 min-w-5 h-5 px-1 text-xs"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </Badge>
      )}
    </Button>
  );
}
