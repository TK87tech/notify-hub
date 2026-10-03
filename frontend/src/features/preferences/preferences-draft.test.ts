/**
 * The preferences edit rules, tested without a page.
 *
 * These are the behaviours that used to be untestable inside a component: the
 * ones where a wrong answer still renders a plausible-looking page and only
 * sends the wrong payload on Save.
 */

import { describe, expect, it } from "vitest";

import type { Preferences } from "@/api/types";
import {
  CHANNELS,
  DEFAULT_QUIET_HOURS,
  guessTimezone,
  isDirty,
  setChannel,
  setQuietHours,
  toggleQuietHours,
  typeLabel,
} from "./preferences-draft";

function preferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    channels: {
      task_assigned: { inApp: true, email: false, push: true },
      comment: { inApp: true, email: false, push: false },
    },
    quietHours: null,
    ...overrides,
  };
}

describe("typeLabel", () => {
  it("turns the API's snake_case names into sentences", () => {
    expect(typeLabel("task_assigned")).toBe("Task assigned");
    expect(typeLabel("deadline_warning")).toBe("Deadline warning");
  });

  it("falls back to the raw name for a type this bundle does not know", () => {
    // The API can add a type without this client being rebuilt. An unlabelled row
    // of switches would be worse than an ugly one.
    expect(typeLabel("mention_received")).toBe("mention_received");
  });
});

describe("CHANNELS", () => {
  it("covers exactly the three the contract declares, in render order", () => {
    expect(CHANNELS.map((channel) => channel.key)).toEqual(["inApp", "email", "push"]);
  });
});

describe("setChannel", () => {
  it("changes one channel and leaves the other two alone", () => {
    const result = setChannel(preferences().channels, "task_assigned", "email", true);

    expect(result.task_assigned).toEqual({ inApp: true, email: true, push: true });
  });

  it("starts an unknown type from all-off rather than undefined", () => {
    // Replacing the whole ChannelSet instead would reset the siblings to
    // undefined, and `checked={channels?.[key] ?? false}` would then read as
    // "off" for a channel the user had deliberately enabled.
    const result = setChannel(preferences().channels, "system", "push", true);

    expect(result.system).toEqual({ inApp: false, email: false, push: true });
  });

  it("does not mutate the input", () => {
    const before = preferences();
    const snapshot = structuredClone(before);

    setChannel(before.channels, "comment", "push", true);

    expect(before).toEqual(snapshot);
  });
});

describe("toggleQuietHours", () => {
  it("creates a real window when enabling, because enabled means non-null", () => {
    const result = toggleQuietHours(preferences(), true);

    expect(result.quietHours).toEqual({
      ...DEFAULT_QUIET_HOURS,
      timezone: guessTimezone(),
    });
  });

  it("keeps an existing window rather than resetting it to the default", () => {
    const existing = { start: "09:00", end: "17:00", timezone: "Europe/London" };

    const result = toggleQuietHours(preferences({ quietHours: existing }), true);

    expect(result.quietHours).toEqual(existing);
  });

  it("clears to null when disabling, because the contract has no enabled flag", () => {
    const result = toggleQuietHours(preferences({ quietHours: { start: "22:00" } }), false);

    expect(result.quietHours).toBeNull();
  });
});

describe("setQuietHours", () => {
  it("merges a partial change into the existing window", () => {
    const result = setQuietHours(preferences({ quietHours: { start: "22:00", end: "07:00" } }), {
      start: "23:30",
    });

    expect(result.quietHours).toEqual({ start: "23:30", end: "07:00" });
  });

  it("refuses to write while quiet hours are off", () => {
    // The inputs only render when the window exists, so this is a stale handler.
    // Writing fields into an invisible window would switch it back on behind the
    // user with no control ever appearing to change.
    const before = preferences();

    expect(setQuietHours(before, { start: "09:00" })).toBe(before);
  });
});

describe("guessTimezone", () => {
  it("returns something usable", () => {
    expect(guessTimezone()).toMatch(/^[A-Za-z]/);
  });

  it("falls back to UTC when Intl has no zone", () => {
    const original = Intl.DateTimeFormat;

    // @ts-expect-error deliberately breaking a global to exercise the catch
    Intl.DateTimeFormat = () => {
      throw new RangeError("no zone");
    };

    try {
      expect(guessTimezone()).toBe("UTC");
    } finally {
      Intl.DateTimeFormat = original;
    }
  });
});

describe("isDirty", () => {
  it("is false for an untouched draft", () => {
    expect(isDirty(preferences(), preferences())).toBe(false);
  });

  it("is false when the server echoes the same preferences in a different key order", () => {
    // JSON objects are unordered, so the server is free to reorder. Comparing
    // raw JSON.stringify output would leave Save permanently enabled after a
    // successful save.
    const saved = preferences({ quietHours: { end: "07:00", start: "22:00", timezone: "UTC" } });
    const draft = preferences({ quietHours: { start: "22:00", timezone: "UTC", end: "07:00" } });

    expect(isDirty(draft, saved)).toBe(false);
  });

  it("is true when a channel changed", () => {
    const saved = preferences();
    const draft = setChannel(saved.channels, "task_assigned", "email", true);

    expect(isDirty({ ...saved, channels: draft }, saved)).toBe(true);
  });

  it("is true when nothing has been saved yet", () => {
    expect(isDirty(preferences(), undefined)).toBe(true);
  });
});
