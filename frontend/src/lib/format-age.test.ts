import { describe, expect, it } from "vitest";

import { formatAge } from "./format-age";

/**
 * Pure-function tests, deliberately covering the boundaries between units.
 *
 * The off-by-one at each boundary is the whole risk: "59s" and "60s" must not
 * both say "just now", and a bug there shows up as a notification claiming to be
 * an hour old while it is still seconds old.
 */
describe("formatAge", () => {
  it("reads as just now for anything under a minute", () => {
    expect(formatAge(0)).toBe("just now");
    expect(formatAge(59)).toBe("just now");
  });

  it("switches to minutes at exactly 60 seconds", () => {
    expect(formatAge(60)).toBe("1m ago");
    expect(formatAge(119)).toBe("1m ago");
    expect(formatAge(3599)).toBe("59m ago");
  });

  it("switches to hours at exactly one hour", () => {
    expect(formatAge(3600)).toBe("1h ago");
    expect(formatAge(86_399)).toBe("23h ago");
  });

  it("switches to days at exactly one day", () => {
    expect(formatAge(86_400)).toBe("1d ago");
    expect(formatAge(6 * 86_400)).toBe("6d ago");
  });

  it("switches to weeks after seven days", () => {
    expect(formatAge(7 * 86_400)).toBe("1w ago");
    expect(formatAge(34 * 86_400)).toBe("4w ago");
  });

  it("switches to months after five weeks", () => {
    expect(formatAge(35 * 86_400)).toBe("1mo ago");
    // 360 days is ~11.8 months, so "11mo" is the honest reading. The previous
    // version fell through to the year branch here and rendered "0y ago".
    expect(formatAge(360 * 86_400)).toBe("11mo ago");
  });

  it("switches to years at exactly one year", () => {
    expect(formatAge(365 * 86_400)).toBe("1y ago");
    expect(formatAge(730 * 86_400)).toBe("2y ago");
  });

  it("never renders NaN or a zero-year age", () => {
    expect(formatAge(Number.NaN)).toBe("just now");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("just now");
    expect(formatAge(360 * 86_400)).not.toBe("0y ago");
  });

  it("does not produce a negative age for a future timestamp", () => {
    // Clock skew between client and server must not render "-3m ago".
    expect(formatAge(-500)).toBe("just now");
  });
});