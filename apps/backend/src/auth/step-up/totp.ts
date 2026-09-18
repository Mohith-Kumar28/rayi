import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP verification.
 *
 * Used for STEP-UP only — proving that the person at the keyboard right now
 * holds the second factor, before an action that could take over an account or
 * move money. Sign-in itself goes through Better Auth.
 *
 * **Why this is implemented here rather than delegated.** Better Auth's
 * `verifyTOTP` is a sign-in endpoint: it establishes or refreshes a session,
 * which is the wrong effect for "confirm you are still you" and would make a
 * step-up indistinguishable from a fresh login in the audit trail.
 *
 * **Why writing it is defensible.** TOTP is a published standard with published
 * TEST VECTORS. `totp.spec.ts` checks this implementation against RFC 6238's own
 * Appendix B table for SHA-1, SHA-256 and SHA-512 — so correctness is verified
 * against the specification rather than against my reading of it. That is a
 * stronger position than an untested dependency.
 *
 * The details that matter, each with a test:
 *
 *   - a drift WINDOW, because phone clocks drift and a rigid check locks people
 *     out of their own accounts for a reason they cannot see or fix
 *   - timing-safe comparison, so a code cannot be found digit by digit
 *   - base32 decoding with padding and lower case tolerated, because that is how
 *     secrets arrive from authenticator apps and QR codes
 */

/** Seconds per code. Universal across authenticator apps. */
export const DEFAULT_PERIOD = 30;

/** Code length. Six is what every authenticator app produces. */
export const DEFAULT_DIGITS = 6;

/**
 * How many periods either side of now are accepted.
 *
 * One step back and one forward — 30 seconds of tolerance in each direction.
 * Zero would reject a phone whose clock is two seconds slow, and the user has no
 * way to diagnose that. Much more than one turns a 30-second code into a
 * multi-minute one, which is the whole security property.
 */
export const DEFAULT_WINDOW = 1;

export interface TotpOptions {
  readonly period?: number;
  readonly digits?: number;
  readonly window?: number;
  readonly algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Injected so tests are deterministic and so a caller can replay a moment. */
  readonly now?: Date;
}

/**
 * Generates the code for one counter value.
 *
 * Exported for the RFC test vectors. Application code verifies rather than
 * generates — we never need to produce a user's code.
 */
export function generateAt(
  secret: Buffer,
  counter: number,
  options: { digits?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {},
): string {
  const digits = options.digits ?? DEFAULT_DIGITS;

  // The counter as an 8-byte big-endian value, per RFC 4226. `writeBigUInt64BE`
  // rather than assembling two 32-bit halves — not because the counter itself
  // overflows (at 30-second steps it will not this millennium) but because the
  // one-line version cannot get the byte order or the high word wrong.
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(options.algorithm ?? 'sha1', secret)
    .update(message)
    .digest();

  // RFC 4226 dynamic truncation. The low nibble of the last byte selects the
  // offset; the high bit of the selected word is masked off so the result is
  // always a positive 31-bit integer.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Whether `code` is valid for `secret` right now.
 *
 * Returns a plain boolean and never explains which step matched: telling a
 * caller "that was the previous window" narrows the search for anyone probing.
 */
export function verifyTotp(input: {
  secret: string | Buffer;
  code: string;
  options?: TotpOptions;
}): boolean {
  const options = input.options ?? {};
  const digits = options.digits ?? DEFAULT_DIGITS;
  const period = options.period ?? DEFAULT_PERIOD;
  const window = options.window ?? DEFAULT_WINDOW;

  const code = input.code.replace(/\s+/g, '');
  // Length and shape are checked first so a malformed code cannot reach the
  // comparison. This leaks only the expected LENGTH, which is public.
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false;

  const secret =
    typeof input.secret === 'string'
      ? decodeBase32(input.secret)
      : input.secret;
  if (!secret || secret.length === 0) return false;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const counter = Math.floor(nowSeconds / period);

  const provided = Buffer.from(code, 'utf8');

  // Every candidate in the window is checked, and the loop is NOT short-circuited
  // on a match: returning early would make a match measurably faster than a miss
  // at the first step, which is a timing signal about which window matched.
  let matched = false;
  for (let step = -window; step <= window; step += 1) {
    const candidate = generateAt(secret, counter + step, {
      digits,
      ...(options.algorithm ? { algorithm: options.algorithm } : {}),
    });
    const expected = Buffer.from(candidate, 'utf8');
    if (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    ) {
      matched = true;
    }
  }

  return matched;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32, as authenticator apps and QR codes produce it.
 *
 * Padding is stripped, case is normalised and whitespace removed, because a
 * secret pasted from a QR code or typed by a human arrives in all of those
 * forms. Returns `null` on any character outside the alphabet rather than
 * silently skipping it — a skipped character yields a DIFFERENT key, and every
 * code would then fail for a reason nothing reports.
 */
export function decodeBase32(input: string): Buffer | null {
  const normalised = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  if (normalised.length === 0) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/**
 * RFC 4648 base32 encoding, for generating a new secret.
 *
 * No padding. Authenticator apps accept unpadded secrets and a trailing `=` in a
 * QR code is a common source of "it says invalid" support tickets.
 */
export function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return out;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * `issuer` appears twice — as a path prefix and as a parameter — because
 * different apps read different ones, and an app that reads neither shows the
 * account as a bare email with no indication of which service it belongs to.
 *
 * Every component is URI-encoded. An email with a `+` or a display name with a
 * space silently produces a secret that scans into the wrong entry otherwise.
 */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
