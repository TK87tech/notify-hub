export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function getLocalMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);

  return hour * 60 + minute;
}

export function isWithinQuietHours(
  quietHours: QuietHours | null,
  now = new Date(),
): boolean {
  if (!quietHours) {
    return false;
  }

  const start = minutesFromTime(quietHours.start);
  const end = minutesFromTime(quietHours.end);
  const current = getLocalMinutes(now, quietHours.timezone);

  // Same start/end means no quiet period.
  if (start === end) {
    return false;
  }

  // Normal period, e.g. 09:00 -> 17:00.
  if (start < end) {
    return current >= start && current < end;
  }

  // Overnight period, e.g. 22:00 -> 07:00.
  return current >= start || current < end;
}

export function quietHoursDelayMs(
  quietHours: QuietHours | null,
  now = new Date(),
): number {
  if (!quietHours || !isWithinQuietHours(quietHours, now)) {
    return 0;
  }

  const end = minutesFromTime(quietHours.end);

  const currentParts = new Intl.DateTimeFormat("en-US", {
    timeZone: quietHours.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = Number(
    currentParts.find((part) => part.type === "year")?.value,
  );
  const month = Number(
    currentParts.find((part) => part.type === "month")?.value,
  );
  const day = Number(
    currentParts.find((part) => part.type === "day")?.value,
  );

  const currentMinutes = getLocalMinutes(now, quietHours.timezone);

  let minutesUntilEnd = end - currentMinutes;

  if (minutesUntilEnd <= 0) {
    minutesUntilEnd += 24 * 60;
  }

  // Add a small buffer so the job is released just after quiet hours end.
  return minutesUntilEnd * 60 * 1000 + 1000;
}