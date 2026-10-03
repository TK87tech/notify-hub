/**
 * Quiet hours and per-type channel preferences. Issue #24.
 *
 * Two things about the contract shape are worth stating, because both are easy to
 * get wrong and neither fails loudly:
 *
 *   - `channels` is a map keyed by notification type, not a single
 *     `{inApp, email, push}` triple. So this page edits one ChannelSet per type,
 *     and a type the API has never heard of keeps its defaults rather than
 *     disappearing.
 *   - `quietHours` is nullable and has no `enabled` flag. "Enabled" therefore
 *     means "non-null": turning quiet hours on means creating the object, and
 *     turning them off means clearing it to null. Adding an `enabled` boolean
 *     here would send a field the API does not declare.
 *
 * Edits are held locally and committed with an explicit Save rather than written
 * per keystroke, so a page navigation cannot lose somebody's changes and a slider
 * drag cannot fire a dozen requests.
 */

import { useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/EmptyState";
import { usePreferences, useUpdatePreferences } from "@/api/hooks";
import { NOTIFICATION_TYPES, type ChannelSet, type Preferences } from "@/api/types";

/** Human labels for the API's snake_case type names. */
const TYPE_LABELS: Record<string, string> = {
  task_assigned: "Task assigned",
  payment_received: "Payment received",
  deadline_warning: "Deadline warning",
  comment: "Comment",
  system: "System",
};

/** Channel toggles, in the order they are rendered for every type. */
const CHANNELS = [
  { key: "inApp", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
] as const satisfies readonly { key: keyof ChannelSet; label: string }[];

export default function PreferencesPage() {
  const current = usePreferences();
  const save = useUpdatePreferences();

  const [draft, setDraft] = useState<Preferences | null>(null);

  // Seeded from the server during render rather than in an effect. React
  // documents this as the supported way to adjust state when incoming data
  // changes; seeding in an effect costs an extra render pass on every mount and
  // trips the react-hooks rule against cascading renders.
  //
  // `draft === null` is the whole guard: it means "not seeded yet". Once seeded
  // the draft is never replaced from the server again, so a background refetch
  // arriving mid-edit cannot overwrite what the user is typing. Every edit below
  // goes through `patch`, which keeps it non-null.
  if (current.data && draft === null) setDraft(current.data);

  if (current.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <span className="sr-only">Loading your preferences</span>

        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (current.isError || !draft) {
    return (
      <EmptyState
        title="Could not load preferences"
        description="We couldn't reach the server. Check your connection and try again."
      />
    );
  }

  const quietHours = draft.quietHours;

  const setChannel = (type: string, key: keyof ChannelSet, value: boolean) => {
    setDraft({
      ...draft,
      channels: {
        ...draft.channels,
        // Only overwrite the named channel: replacing the whole ChannelSet
        // would reset the other two toggles to undefined.
        [type]: { ...(draft.channels[type] ?? { inApp: false, email: false, push: false }), [key]: value },
      },
    });
  };

  const toggleQuietHours = (enabled: boolean) => {
    setDraft({
      ...draft,
      quietHours: enabled
        ? // A sensible window rather than an empty one: null would render two
          // blank time inputs and PATCH them straight back.
          (quietHours ?? { start: "22:00", end: "07:00", timezone: guessTimezone() })
        : null,
    });
  };

  const setQuietHours = (changes: Partial<NonNullable<Preferences["quietHours"]>>) => {
    if (!quietHours) return;

    setDraft({ ...draft, quietHours: { ...quietHours, ...changes } });
  };

  const isDirty = JSON.stringify(draft) !== JSON.stringify(current.data);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    try {
      await save.mutateAsync(draft);
      toast.success("Preferences saved");
    } catch {
      // The draft is deliberately left alone: the user's edits are still on
      // screen and still saveable, rather than silently reverting under them.
      toast.error("Could not save preferences. Your changes are still here - try again.");
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Preferences</h2>

        <p className="text-sm text-muted-foreground">
          Choose how and when NotifyHub is allowed to reach you.
        </p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>

          <CardDescription>
            During quiet hours, low-priority notifications wait until the window closes. Urgent
            and normal notifications are always delivered.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="quietHours">Enable quiet hours</Label>

              <p className="text-sm text-muted-foreground">
                Holds back low-priority notifications until the window ends.
              </p>
            </div>

            <Switch id="quietHours" checked={quietHours !== null} onCheckedChange={toggleQuietHours} />
          </div>

          {quietHours && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="quietStart">Starts at</Label>

                <Input
                  id="quietStart"
                  type="time"
                  value={quietHours.start ?? ""}
                  onChange={(event) => setQuietHours({ start: event.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="quietEnd">Ends at</Label>

                <Input
                  id="quietEnd"
                  type="time"
                  value={quietHours.end ?? ""}
                  onChange={(event) => setQuietHours({ end: event.target.value })}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="timezone">Timezone</Label>

                <Input
                  id="timezone"
                  value={quietHours.timezone ?? ""}
                  placeholder="Europe/London"
                  aria-describedby="timezone-help"
                  onChange={(event) => setQuietHours({ timezone: event.target.value })}
                />

                <p id="timezone-help" className="text-xs text-muted-foreground">
                  An IANA timezone name, so the window stays correct when daylight saving changes.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>

          <CardDescription>
            Per notification type. Turning a channel off stops future notifications on it;
            anything already queued still follows the rules in force when it was created.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {NOTIFICATION_TYPES.map((type) => {
            const channels = draft.channels[type];

            return (
              <div key={type} className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">{TYPE_LABELS[type] ?? type}</p>

                <div className="flex flex-wrap gap-4">
                  {CHANNELS.map((channel) => (
                    <div key={channel.key} className="flex items-center gap-2">
                      <Switch
                        id={`${type}-${channel.key}`}
                        size="sm"
                        checked={channels?.[channel.key] ?? false}
                        onCheckedChange={(value) => setChannel(type, channel.key, value)}
                      />

                      <Label htmlFor={`${type}-${channel.key}`} className="text-xs font-normal">
                        {channel.label}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>

        <CardFooter className="justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!isDirty}
            onClick={() => setDraft(current.data ?? null)}
          >
            Discard
          </Button>

          <Button type="submit" disabled={!isDirty || save.isPending} className="gap-1.5">
            <Save className="size-4" />

            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

/**
 * The browser's own zone, used only to prefill a newly enabled window.
 *
 * `Intl` rather than a hardcoded zone, and guarded because a thrown RangeError
 * from a malformed zone must not take the page down - the field stays editable
 * either way.
 */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}