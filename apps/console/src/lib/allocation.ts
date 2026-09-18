/**
 * The two derivations the allocate form depends on, kept out of the component
 * so they can be tested directly.
 *
 * Both were defects in the first version of this screen, and both are the kind
 * that produce a confident wrong number rather than an error.
 */

/**
 * Major units as typed by a human → integer minor units as a string.
 *
 * Returns `null` for anything it cannot convert exactly. Deliberately not a
 * best-effort parse: a function that turns "1.005" into "100" has silently
 * decided to round someone's money down, and a function that turns "-5" into
 * "-500" has produced a withdrawal from a form labelled "allocate".
 *
 * No `parseFloat` anywhere. `150.50 * 100` is 15049.999999999998 in binary
 * floating point — a real lost cent, and the canonical way money systems break.
 */
export function toMinorUnits(input: string, exponent = 2): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Digits, at most one dot, at most `exponent` decimal places, never a sign.
  const match = new RegExp(`^(\\d*)(?:\\.(\\d{0,${exponent}}))?$`).exec(trimmed);
  if (!match) return null;

  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;

  const minor = `${whole || '0'}${fraction.padEnd(exponent, '0')}`;

  // Strip leading zeros but keep a bare "0", so the value always matches the
  // contract's ^-?(0|[1-9][0-9]*)$ and never arrives as "007".
  const normalised = minor.replace(/^0+(?=\d)/, '');
  return normalised === '' ? '0' : normalised;
}

/**
 * The idempotency key for an allocation.
 *
 * Names the INTENT — this amount, to this campaign, against this state of it —
 * rather than the attempt.
 *
 * Deterministic, so a refresh, a second tab or a React remount produce the
 * identical key. A random key held in component state is destroyed by exactly
 * the refresh a user reaches for when a money action appears to hang, which is
 * precisely when the duplicate would be submitted.
 *
 * And it includes the campaign's currently-allocated balance, so it differs for
 * a genuinely new intent. Keying on the amount alone would silently swallow a
 * legitimate second allocation of the same size: the brand adds $5,000, decides
 * to add another $5,000, and the UI reports "Accepted" while nothing happens.
 */
export function allocationIdempotencyKey(input: {
  campaignId: string;
  allocatedMinor: string;
  amountMinor: string;
}): string {
  return `allocate:${input.campaignId}:${input.allocatedMinor}:${input.amountMinor}`;
}
