import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Svix webhook signature verification.
 *
 * Resend signs its webhooks with Svix. The official `svix` package would be the
 * obvious choice and is normally the right one — signature verification is
 * exactly the code you want maintained by the people who define the scheme.
 *
 * It is not used here for one specific reason: `svix@2` ships ESM only, and this
 * backend compiles to CommonJS with a CommonJS jest runtime. The package would
 * run in production (Node supports `require(esm)`) but could not be loaded in a
 * test, which would leave the signature path — the only thing standing between
 * a stranger and our webhook handler — with no test coverage at all. An
 * untestable dependency in that position is worse than a tested implementation
 * of a published scheme.
 *
 * This is not a novel construction. It is HMAC-SHA256 over a documented string,
 * and every detail that could go wrong has a test:
 *
 *   - timing-safe comparison, so the signature cannot be guessed byte by byte
 *   - a timestamp tolerance, so a captured request cannot be replayed forever
 *   - multiple space-separated signatures, which Svix sends during secret
 *     rotation — accepting ANY valid one is what makes rotation possible
 *   - the `whsec_` prefix stripped and the remainder base64-decoded, because
 *     HMAC over the printable form is a different key entirely
 */

/** How far out of date a signed timestamp may be. Svix's own default. */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

export type VerificationFailure =
  | 'missing_headers'
  | 'malformed_timestamp'
  | 'timestamp_too_old'
  | 'timestamp_in_future'
  | 'no_v1_signature'
  | 'signature_mismatch'
  | 'malformed_secret';

export type VerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VerificationFailure };

/**
 * Verifies a Svix-signed request.
 *
 * `body` MUST be the raw bytes as received. Re-serialising parsed JSON produces
 * a different string — key order, whitespace, number formatting — and the
 * signature will not match. That is the single most common way to get this
 * wrong, and it fails closed, so it looks like an attack rather than a bug.
 */
export function verifySvixSignature(input: {
  body: string;
  headers: SvixHeaders;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): VerificationResult {
  const { id, timestamp, signature } = input.headers;

  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing_headers' };
  }

  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // Replay protection. Without it a request captured once is valid forever, and
  // a webhook that moves state is a replayable command.
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);

  if (nowSeconds - seconds > tolerance) {
    return { ok: false, reason: 'timestamp_too_old' };
  }
  // Also bounded in the future: a clock-skewed or forged forward timestamp would
  // otherwise extend the replay window arbitrarily.
  if (seconds - nowSeconds > tolerance) {
    return { ok: false, reason: 'timestamp_in_future' };
  }

  const key = decodeSecret(input.secret);
  if (!key) return { ok: false, reason: 'malformed_secret' };

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${input.body}`)
    .digest();

  // Svix sends a space-separated list during secret rotation, each prefixed with
  // its version. Accepting any valid one is what makes rotating a secret
  // possible without dropping deliveries.
  const candidates = signature
    .split(' ')
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice('v1,'.length));

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_v1_signature' };
  }

  for (const candidate of candidates) {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, 'base64');
    } catch {
      continue;
    }
    // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
    // first — and that comparison leaks only the LENGTH of the digest, which is
    // fixed at 32 bytes for SHA-256 and therefore reveals nothing.
    if (
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    ) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'signature_mismatch' };
}

/**
 * `whsec_<base64>` becomes the raw key bytes.
 *
 * The prefix is not part of the key and the remainder is base64. Running HMAC
 * over the printable form is a different key entirely, and every signature would
 * fail — silently, and looking exactly like an attacker.
 */
function decodeSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  if (trimmed === '') return null;

  const encoded = trimmed.startsWith('whsec_')
    ? trimmed.slice('whsec_'.length)
    : trimmed;
  const key = Buffer.from(encoded, 'base64');
  return key.length > 0 ? key : null;
}
