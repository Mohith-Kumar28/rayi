import type { Problem } from '@rayi/contracts';

/**
 * Reads an RFC 9457 problem from an untrusted response body.
 *
 * **Why this is hand-written rather than `ProblemSchema.parse`.**
 *
 * `ProblemSchema` lives in `@rayi/contracts`, which has a single barrel export.
 * Importing one schema from it pulls in every operation definition and every
 * Zod schema for the entire API — and Zod itself — into the browser bundle. That
 * was 672 KB shipped to every visitor so that a failed request could be parsed.
 *
 * The cost lands hardest on the population that can least afford it: a creator
 * opening this on mobile data to check one payout. So the frontend READS a
 * problem with a narrow guard, and the contract remains the authority on what a
 * problem IS.
 *
 * The obvious risk is drift — a guard that accepts something the contract would
 * reject, or vice versa. `problem.test.ts` feeds the contract's own schema and
 * this guard the same inputs and asserts they agree, so drift is a failing test
 * rather than a surprise in an error path nobody looks at.
 *
 * `type` imports are erased at compile time, so the `Problem` type above costs
 * nothing at runtime.
 */

/** Matches `ERROR_CODES` in @rayi/contracts. Asserted equal by test. */
const KNOWN_CODES = new Set([
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'step_up_required',
  'not_found',
  'idempotency_key_reused',
  'insufficient_unallocated_funds',
  'budget_envelope_exceeded',
  'daily_limit_exceeded',
  'deposit_not_settled',
  'organization_frozen',
  'conflict',
  'rate_limited',
  'internal_error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a `Problem`, or `null` when the body is not one.
 *
 * Deliberately returns null rather than throwing: the caller is already handling
 * a failure, and a parser that throws inside an error path turns a 409 into an
 * unhandled exception with no message a user can act on.
 */
export function parseProblem(body: unknown): Problem | null {
  if (!isRecord(body)) return null;

  const { type, title, status, code, requestId } = body;

  // `code` is THE contract — clients branch on it and never on a message
  // string — so a body without a recognised one is not a problem we understand,
  // whatever else it contains.
  if (typeof code !== 'string' || !KNOWN_CODES.has(code)) return null;
  if (typeof title !== 'string' || typeof type !== 'string') return null;
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  if (typeof requestId !== 'string') return null;

  const problem: Problem = {
    type,
    title,
    status,
    code: code as Problem['code'],
    requestId,
  };

  if (typeof body['detail'] === 'string') {
    return withDetail(problem, body['detail'], body['instance'], body['challenge']);
  }
  return withDetail(problem, undefined, body['instance'], body['challenge']);
}

function withDetail(
  problem: Problem,
  detail: string | undefined,
  instance: unknown,
  challenge: unknown,
): Problem {
  return {
    ...problem,
    ...(detail !== undefined ? { detail } : {}),
    ...(typeof instance === 'string' ? { instance } : {}),
    /**
     * Only populated for `step_up_required`.
     *
     * The amount and counterparty shown in a confirmation dialog MUST come from
     * here and never from client cache — otherwise a compromised dependency
     * could display one amount while a different one is paid.
     */
    ...(isRecord(challenge) &&
    typeof challenge['challengeId'] === 'string' &&
    typeof challenge['reason'] === 'string' &&
    typeof challenge['expiresAt'] === 'string'
      ? {
          challenge: {
            challengeId: challenge['challengeId'],
            reason: challenge['reason'],
            expiresAt: challenge['expiresAt'],
          },
        }
      : {}),
  };
}
