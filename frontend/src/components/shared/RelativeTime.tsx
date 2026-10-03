import { useEffect, useState } from "react";

import { formatAge } from "@/lib/format-age";

interface RelativeTimeProps {
  date: Date | string;
  /**
   * How often the label is recomputed. The default matches the coarsest unit
   * shown ("just now" for the first minute), so a list of rows does not
   * re-render once a second to redisplay the same word.
   */
  refreshMs?: number;
}

/**
 * Relative time, kept honest about the passage of time.
 *
 * The obvious implementation reads `Date.now()` during render. That is wrong in
 * two ways: React treats a render as a pure function of props, so the label
 * freezes at whatever the time was when the row mounted - a notification from an
 * hour ago keeps reading "just now" on a page left open all afternoon - and
 * asking the clock mid-render is an impure read that the React compiler rejects
 * outright.
 *
 * So the current time is state, seeded once and advanced by an interval. The
 * absolute timestamp is rendered as the element's `title`, which is what makes a
 * relative label that has drifted recoverable by hover rather than misleading.
 */
export function RelativeTime({ date, refreshMs = 60_000 }: RelativeTimeProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), refreshMs);

    return () => clearInterval(timer);
  }, [refreshMs]);

  const time = new Date(date).getTime();

  // An unparseable date would otherwise render "NaNd ago", which is worse than
  // admitting the input was bad.
  if (Number.isNaN(time)) return <span>unknown time</span>;

  const absolute = new Date(time).toISOString();

  return (
    <time dateTime={absolute} title={absolute}>
      {formatAge(Math.floor((now - time) / 1000))}
    </time>
  );
}