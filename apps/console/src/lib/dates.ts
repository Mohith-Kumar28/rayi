/**
 * Date rendering.
 *
 * One distinction, and it is the whole file: some of our timestamps are a
 * MOMENT and some are a DAY.
 *
 * A moment — when a payout arrived, when a session was created — is genuinely
 * a point in time and belongs in the reader's own timezone.
 *
 * A day — when a budget ceiling expires, when a campaign ends — is a calendar
 * date that somebody chose in a date picker. It is stored as the end of that day
 * in UTC, so rendering it in a timezone west of UTC is fine and rendering it
 * anywhere east of UTC rolls it to the next day: finance sets 31 December and
 * the screen says 1 January. That is not a rounding difference, it is the
 * product telling them their approval lasts a day longer than it does.
 */

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
};

/** A calendar date, rendered in the timezone it was chosen in. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', DAY_FORMAT);
}

/** A calendar date without the year, for anything inside the current one. */
export function formatDayShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** A moment in time, in the reader's own timezone. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
