import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signature verification.
 *
 * Deliberately NOT `stripe.webhooks.constructEvent`. That helper both verifies
 * and parses, and it lives on a `Stripe` client constructed with an API key —
 * which the webhooks process does not hold and must not hold. Verification needs
 * only the endpoint secret, and keeping it separate is what lets the webhook
 * surface carry no credential capable of moving money.
 *
 * **The difference from Svix that is easy to get wrong.** Svix strips the
 * `whsec_` prefix and base64-DECODES the remainder to get the key. Stripe uses
 * the endpoint secret **as-is**, the whole string including the prefix, as the
 * HMAC key.
 *
 * Having implemented both in one file tree, that asymmetry is exactly the kind
 * of thing that gets unified by a well-meaning refactor — and the result fails
 * closed, rejecting every delivery, looking like an attack rather than a bug.
 * Both implementations are separate on purpose, and both have tests.
 *
 * Signed payload:  `{timestamp}.{raw body}`
 * Header:          `t=1614556800,v1=abc...,v1=def...`
 */

/** Stripe's documented default tolerance. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type StripeVerificationFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'malformed_timestamp'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'no_v1_signature'
  | 'signature_mismatch'
  | 'empty_secret';

export type StripeVerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StripeVerificationFailure };

/**
 * Verifies a `Stripe-Signature` header.
 *
 * `body` MUST be the raw bytes as received. Re-serialising parsed JSON produces
 * a different string and the signature will never match.
 */
export function verifyStripeSignature(input: {
  body: string;
  header: string | undefined;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): StripeVerificationResult {
  if (!input.header) return { ok: false, reason: 'missing_signature' };
  if (input.secret.trim() === '') return { ok: false, reason: 'empty_secret' };

  const parsed = parseHeader(input.header);
  if (!parsed) return { ok: false, reason: 'malformed_signature' };

  const seconds = Number(parsed.timestamp);
  if (!Number.isInteger(seconds)) return { ok: false, reason: 'malformed_timestamp' };

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);

  // Replay protection. A webhook that moves state is a replayable command
  // without it, and Stripe retries for three days — so a captured delivery would
  // otherwise stay usable indefinitely.
  if (nowSeconds - seconds > tolerance) return { ok: false, reason: 'timestamp_too_old' };
  if (seconds - nowSeconds > tolerance) return { ok: false, reason: 'timestamp_in_future' };

  if (parsed.signatures.length === 0) return { ok: false, reason: 'no_v1_signature' };

  // The secret is used AS-IS — the whole `whsec_...` string. Not base64-decoded,
  // not stripped of its prefix. See the note above about Svix.
  const expected = createHmac('sha256', input.secret)
    .update(`${parsed.timestamp}.${input.body}`)
    .digest();

  for (const candidate of parsed.signatures) {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, 'hex');
    } catch {
      continue;
    }
    // Length compared first because `timingSafeEqual` throws on a mismatch. The
    // length is fixed at 32 bytes for SHA-256, so this leaks nothing.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * `t=123,v1=abc,v1=def` → `{ timestamp: '123', signatures: ['abc', 'def'] }`.
 *
 * Multiple `v1` entries appear while an endpoint secret is being rotated, and
 * accepting any of them is what makes rotation possible without dropping
 * deliveries. A dropped Stripe delivery is a money event we never see.
 *
 * Unknown schemes (`v0`, and anything Stripe adds later) are ignored rather than
 * rejected: a future scheme must not break an endpoint that correctly verifies
 * the version it understands.
 */
function parseHeader(header: string): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === 't') timestamp = value;
    else if (key === 'v1' && value !== '') signatures.push(value);
  }

  if (!timestamp) return null;
  return { timestamp, signatures };
}
