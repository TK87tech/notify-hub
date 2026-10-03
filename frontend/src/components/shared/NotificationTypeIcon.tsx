/**
 * One icon per notification type, in a colour that means something.
 *
 * Issue #4 asked for this mapping as a shared component. It had been living
 * inside `NotificationRow`, which meant the panel and the full list were only
 * consistent by accident - the day a second call site needed the same icon it
 * would have been copied, and the two would drift.
 *
 * Keyed to the API's enum - task_assigned, payment_received, deadline_warning,
 * comment, system - rather than to delivery channels. A notification's type is
 * what it is about, and channel is already visible from where it arrived; a
 * single user task assigned by email and by push should look like the same event.
 *
 * Colours come from `--status-*` tokens rather than literal Tailwind palette
 * classes, because palette classes do not change with the theme and would leave
 * these icons at a fixed contrast in dark mode. `theme-contrast.test.ts` checks
 * every one of them against `--background` in both themes.
 */

import { ClipboardCheck, Clock, CreditCard, MessageSquare, Settings } from "lucide-react";

import { cn } from "cn";
import type { NotificationType } from "@/api/types";

const TYPE_ICON = {
  task_assigned: ClipboardCheck,
  payment_received: CreditCard,
  deadline_warning: Clock,
  comment: MessageSquare,
  system: Settings,
} satisfies Record<NotificationType, typeof ClipboardCheck>;

/**
 * Three types carry a hue; the other two stay neutral.
 *
 * That is a deliberate gap rather than an oversight. Task, payment and deadline
 * have an obvious intent worth colouring - incoming work, money, time running
 * out - whereas a comment and a system notice do not, and giving them invented
 * colours would suggest a distinction the product does not make. They differ by
 * shade instead, which still reads as "not one of the three urgent kinds".
 */
const TYPE_CLASS = {
  task_assigned: "text-status-info",
  payment_received: "text-status-success",
  deadline_warning: "text-status-warning",
  comment: "text-muted-foreground",
  system: "text-foreground",
} satisfies Record<NotificationType, string>;

interface NotificationTypeIconProps {
  type: NotificationType;
  className?: string;
}

export function NotificationTypeIcon({ type, className }: NotificationTypeIconProps) {
  const Icon = TYPE_ICON[type];

  return (
    // The type is decoration here: every row that shows this icon already shows the
    // notification's own title and body, so announcing the type again would just
    // repeat context the reader already has.
    <Icon className={cn("size-4", TYPE_CLASS[type], className)} aria-hidden="true" />
  );
}
