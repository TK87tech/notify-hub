/**
 * One notification, used by both the panel and the full list.
 *
 * Issue #22 asks that clicking a notification mark it read and follow its link.
 * Both happen, in that order and for different reasons: marking read is a write
 * that can fail, following the link is navigation. If the link were followed
 * first the write could be cancelled by unmounting this component, leaving the
 * notification unread while looking read - so the read is fired first and never
 * awaited before navigating, because a slow write should not stall the click.
 */

import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";

import { NotificationTypeIcon } from "@/components/shared/NotificationTypeIcon";
import { RelativeTime } from "@/components/shared/RelativeTime";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import { useMarkRead } from "@/api/hooks";
import type { Notification, NotificationPriority } from "@/api/types";

interface NotificationRowProps {
  notification: Notification;
  /** Called after a click, so the panel can close itself. */
  onNavigate?: () => void;
  showTimestamp?: boolean;
}

/** Kept to the three priorities the API actually defines. */
const PRIORITY_VARIANT: Record<NotificationPriority, "destructive" | "secondary" | "outline"> = {
  urgent: "destructive",
  normal: "outline",
  low: "secondary",
};

export function NotificationRow({
  notification,
  onNavigate,
  showTimestamp = true,
}: NotificationRowProps) {
  const markRead = useMarkRead();

  const isUnread = !notification.read;

  const handleClick = () => {
    if (isUnread) {
      markRead.mutate(notification.id);
    }

    onNavigate?.();
  };

  const body = (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0">
        <NotificationTypeIcon type={notification.type} />
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className={cn("text-sm leading-snug", !isUnread && "text-muted-foreground")}>
            {notification.title}
          </p>

          {/* `priority` is optional in the contract, so this has to tolerate undefined -
              an absent priority is not an error, it just gets no badge. */}
          {notification.priority && notification.priority !== "normal" && (
            <Badge variant={PRIORITY_VARIANT[notification.priority]} className="shrink-0 capitalize">
              {notification.priority}
            </Badge>
          )}
        </div>

        {notification.body && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{notification.body}</p>
        )}

        {showTimestamp && (
          /* RelativeTime renders its own <time dateTime> with a title
             attribute carrying the absolute timestamp, so wrapping it in another
             <time> here would nest two of them. */
          <span className="block text-xs text-muted-foreground">
            <RelativeTime date={notification.createdAt} />
          </span>
        )}
      </div>

      {notification.link && (
        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );

  return (
    <Link
      to={notification.link ?? "/"}
      onClick={handleClick}
      className={cn(
        "block border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-accent",
        // Weight rather than colour alone: an unread row has to be
        // distinguishable without relying on a hue the user may not perceive.
        isUnread && "bg-accent/40 font-medium",
      )}
    >
      {/* Announced as unread so the state is not visual-only. */}
      {isUnread && <span className="sr-only">Unread. </span>}

      {body}
    </Link>
  );
}