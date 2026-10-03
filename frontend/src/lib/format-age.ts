/**
 * Human-readable age of a timestamp, as a pure function.
 *
 * Separated from the component so it can be tested without rendering anything,
 * and so the wording is decided in one place.
 *
 * Every threshold is on `days` rather than on the derived unit. That matters: an
 * earlier version branched on the unit it had already computed, so 360 days fell
 * through to the year branch and rendered "0y ago", because floor(360 / 365) is
 * zero. Branching on the raw day count removes that whole class of off-by-one.
 */
export function formatAge(seconds: number): string {
  // Covers NaN and +/-Infinity from a bad timestamp or clock skew, and the
  // future-dated case where a negative age would render "-3m ago". The component
  // renders "unknown time" for unparseable dates; this is the last line of
  // defence so the pure function can never emit "NaNy ago".
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(seconds / 3600);

  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(seconds / 86_400);

  if (days < 7) return `${days}d ago`;

  if (days < 35) return `${Math.floor(days / 7)}w ago`;

  // 30.44 is a mean month, so "1mo" appears at ~30 days rather than drifting.
  if (days < 365) return `${Math.floor(days / 30.44)}mo ago`;

  return `${Math.floor(days / 365)}y ago`;
}