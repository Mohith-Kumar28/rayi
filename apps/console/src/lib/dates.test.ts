import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatDay, formatDayShort } from './dates';

/**
 * The bug this file exists to prevent, reproduced.
 *
 * A budget ceiling expiring at the end of 31 December UTC renders as 1 January
 * for every reader east of UTC unless the formatter is pinned. The screen would
 * then tell finance their approval lasts a day longer than it does.
 */
describe('calendar dates', () => {
  const original = process.env.TZ;

  beforeAll(() => {
    // Well east of UTC, where the rollover actually happens.
    process.env.TZ = 'Asia/Tokyo';
  });
  afterAll(() => {
    process.env.TZ = original;
  });

  it('keeps an end-of-day UTC date on its own day, east of UTC', () => {
    expect(formatDay('2026-12-31T23:59:59.000Z')).toBe('Dec 31, 2026');
    expect(formatDayShort('2026-12-31T23:59:59.000Z')).toBe('Dec 31');
  });

  it('shows the naive rendering would have rolled over', () => {
    // Not an assertion about our code — an assertion that the hazard is real,
    // so nobody later decides the timeZone option was superstition.
    const naive = new Date('2026-12-31T23:59:59.000Z').toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    expect(naive).toBe('Jan 1, 2027');
  });

  it('is stable at the start of a day too', () => {
    expect(formatDay('2026-09-01T00:00:00.000Z')).toBe('Sep 1, 2026');
  });
});
