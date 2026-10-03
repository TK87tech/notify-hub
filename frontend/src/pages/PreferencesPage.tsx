/**
 * Quiet hours and per-type channel preferences. Issue #24.
 *
 * Edits are held locally and committed with an explicit Save rather than written
 * per keystroke, so a page navigation cannot lose somebody's changes and a slider
 * drag cannot fire a dozen requests.
 *
 * This file is the rendering. The rules for what an edit actually does to the
 * payload - the nullable `quietHours` object, the per-type channel map - are in
 * `features/preferences/preferences-draft.ts`, where they can be tested without
 * mounting a page.
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
import {
  CHANNELS,
  isDirty as draftIsDirty,
  setChannel as setChannelIn,
  setQuietHours as withQuietHours,
  toggleQuietHours as withQuietHoursToggled,
  typeLabel,
  type QuietHours,
} from "@/features/preferences/preferences-draft";
import { usePreferences, useUpdatePreferences } from "@/api/hooks";
import { NOTIFICATION_TYPES, type ChannelSet, type Preferences } from "@/api/types";

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
    setDraft({ ...draft, channels: setChannelIn(draft.channels, type, key, value) });
  };

  const toggleQuietHours = (enabled: boolean) => {
    setDraft(withQuietHoursToggled(draft, enabled));
  };

  const setQuietHours = (changes: Partial<QuietHours>) => {
    setDraft(withQuietHours(draft, changes));
  };

  const isDirty = draftIsDirty(draft, current.data);

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
                <p className="text-sm font-medium">{typeLabel(type)}</p>

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