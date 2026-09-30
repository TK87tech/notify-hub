import { describe, expect, it } from "vitest";

import {
  isWithinQuietHours,
  quietHoursDelayMs,
} from "../src/lib/quiet-hours.js";

describe("quiet hours", () => {
  it("detects a time inside quiet hours", () => {
    const now = new Date("2026-09-30T23:30:00.000Z");

    expect(
      isWithinQuietHours(
        {
          start: "22:00",
          end: "07:00",
          timezone: "Africa/Lagos",
        },
        now,
      ),
    ).toBe(true);
  });

  it("detects a time outside quiet hours", () => {
    const now = new Date("2026-09-30T10:00:00.000Z");

    expect(
      isWithinQuietHours(
        {
          start: "22:00",
          end: "07:00",
          timezone: "Africa/Lagos",
        },
        now,
      ),
    ).toBe(false);
  });

  it("handles quiet hours that do not cross midnight", () => {
    const now = new Date("2026-09-30T12:30:00.000Z");

    expect(
      isWithinQuietHours(
        {
          start: "12:00",
          end: "14:00",
          timezone: "Africa/Lagos",
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false when quiet hours start and end are the same", () => {
    const now = new Date("2026-09-30T23:30:00.000Z");

    expect(
      isWithinQuietHours(
        {
          start: "22:00",
          end: "22:00",
          timezone: "Africa/Lagos",
        },
        now,
      ),
    ).toBe(false);
  });

  it("calculates the delay until quiet hours end", () => {
    const now = new Date("2026-09-30T22:30:00.000Z");

    const delay = quietHoursDelayMs(
      {
        start: "22:00",
        end: "07:00",
        timezone: "Africa/Lagos",
      },
      now,
    );

    expect(delay).toBe(7.5 * 60 * 60 * 1000 + 1000);
  });

  it("returns zero delay outside quiet hours", () => {
    const now = new Date("2026-09-30T10:00:00.000Z");

    const delay = quietHoursDelayMs(
      {
        start: "22:00",
        end: "07:00",
        timezone: "Africa/Lagos",
      },
      now,
    );

    expect(delay).toBe(0);
  });
});