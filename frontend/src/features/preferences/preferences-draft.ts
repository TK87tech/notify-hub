/**
 * Editing rules for the preferences page.
 *
 * These live in a feature folder rather than inside `PreferencesPage` because
 * they are the part that is easy to get quietly wrong, and in a component none
 * of it can be tested without also standing up the whole page.
 *
 * Two contract details drive most of the code below, and both fail silently if
 * ignored:
 *
 *   - `channels` is a map keyed by notification type, not a single
 *     `{inApp, email, push}` triple. So a page edits one ChannelSet per type, and
 *     a type the API has never heard of keeps its defaults rather than
 *     disappearing.
 *   - `quietHours` is nullable and has no `enabled` flag. "Enabled" therefore
 *     means "non-null": turning quiet hours on means creating the object, and
 *     turning them off means clearing it to null. Adding an `enabled` boolean
 *     here would send a field the API does not declare.
 */

import type { ChannelSet, Preferences } from "@/api/types";

export type QuietHours = NonNullable<Preferences["quietHours"]>;
export type Channels = Preferences["channels"];

/** Human labels for the API's snake_case type names. */
const TYPE_LABELS: Record<string, string> = {
  task_assigned: "Task assigned",
  payment_received: "Payment received",
  deadline_warning: "Deadline warning",
  comment: "Comment",
  system: "System",
};

/**
 * Falls back to the raw type rather than rendering nothing.
 *
 * The API may add a type this bundle has never heard of. Showing the raw name is
 * ugly but honest, and it keeps the row usable instead of leaving an unlabelled
 * block of switches.
 */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** Channel toggles, in the order they are rendered for every type. */
export const CHANNELS = [
  { key: "inApp", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
] as const satisfies readonly { key: keyof ChannelSet; label: string }[];

/**
 * The window a newly enabled quiet-hours toggle starts from.
 *
 * A real window rather than an empty one: null would render two blank time inputs
 * and PATCH them straight back, so "enable" would quietly save an unset window.
 */
export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;

const CHANNELS_OFF: ChannelSet = { inApp: false, email: false, push: false };

/**
 * The browser's own zone, used only to prefill a newly enabled window.
 *
 * `Intl` rather than a hardcoded zone, and guarded because a thrown RangeError
 * from a malformed zone must not take the page down - the field stays editable
 * either way.
 */
export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Turns one channel on or off without disturbing the other two. */
export function setChannel(
  channels: Channels,
  type: string,
  key: keyof ChannelSet,
  value: boolean,
): Channels {
  return {
    ...channels,
    // Only overwrite the named channel: replacing the whole ChannelSet would
    // reset the other two toggles to false.
    [type]: { ...(channels[type] ?? CHANNELS_OFF), [key]: value },
  };
}

/** Enabled means non-null, so switching off clears the object rather than flagging it. */
export function toggleQuietHours(preferences: Preferences, enabled: boolean): Preferences {
  return {
    ...preferences,
    quietHours: enabled
      ? (preferences.quietHours ?? { ...DEFAULT_QUIET_HOURS, timezone: guessTimezone() })
      : null,
  };
}

export function setQuietHours(
  preferences: Preferences,
  changes: Partial<QuietHours>,
): Preferences {
  const quietHours = preferences.quietHours;

  // Guarded rather than assumed. The inputs only render while quietHours is
  // non-null, so reaching here with null means a stale handler, and writing
  // fields into an invisible window would switch it back on behind the user.
  if (!quietHours) return preferences;

  return { ...preferences, quietHours: { ...quietHours, ...changes } };
}

/**
 * Whether the draft differs from what the server holds.
 *
 * Key order is normalised before comparing. A plain `JSON.stringify` pair would
 * call an untouched draft dirty as soon as the server echoed the same preferences
 * back in a different key order - which it is free to do, since JSON objects are
 * unordered - and leave Save permanently enabled after a successful save.
 */
export function isDirty(draft: Preferences, saved: Preferences | undefined): boolean {
  return stableStringify(draft) !== stableStringify(saved);
}

/** JSON with object keys sorted, so equal values always produce equal strings. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);

  return `{${entries.join(",")}}`;
}
