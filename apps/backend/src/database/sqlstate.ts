/**
 * Reading a PostgreSQL SQLSTATE off an error, wherever the driver buried it.
 *
 * Lives in `database/` rather than in `ledger/` because BOTH sides of the money
 * boundary need it and the api process may not import from `src/ledger/` — that
 * rule is the load-bearing one in this codebase, and duplicating a five-line
 * error walker to satisfy it would mean two versions of "how do we recognise a
 * constraint violation" drifting apart.
 *
 * It contains no ledger knowledge: it is the shape of a driver error, nothing
 * more. Which codes mean what, and which may be retried, stays in
 * `ledger/infrastructure/retry.ts` where the money path can reason about it.
 */

/** Walks the `cause` chain, since drivers and ORMs wrap the original error. */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      meta?: { code?: unknown };
    };

    // node-postgres puts SQLSTATE on `code`; Prisma sometimes tucks the driver
    // error under `meta`.
    for (const value of [candidate.code, candidate.meta?.code]) {
      if (typeof value === 'string' && SQLSTATE_SHAPE.test(value)) return value;
    }
    current = candidate.cause;
  }

  /*
   * Last resort: read it out of the message.
   *
   * `PrismaClientUnknownRequestError` carries NO structured code and NO meta —
   * it stringifies the whole connector error into `message`, so a check
   * violation arriving this way is invisible to the lookups above. That is not
   * hypothetical: it is how every constraint refusal on a Prisma `updateMany`
   * surfaces, and reading it as "no SQLSTATE" means treating a correct database
   * refusal as an unknown failure.
   *
   * Deliberately anchored on `code: "…"`, which is the connector's own
   * rendering, so an arbitrary five-character token in an error message cannot
   * be mistaken for a SQLSTATE.
   */
  const message = error instanceof Error ? error.message : '';
  const embedded = /\bcode:\s*"([0-9A-Z]{5})"/.exec(message);
  return embedded?.[1];
}

/** Five characters, digits and capitals. Matches Prisma's own `P####` too. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/** `check_violation`. The database correctly refusing something. */
export const CHECK_VIOLATION = '23514';
/** `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Whether an error is a check violation naming a SPECIFIC constraint.
 *
 * Named deliberately, never "was it a 23514": a bare check-violation catch
 * swallows every other invariant on the table too, so a bug that trips a
 * different constraint would be reported as an ordinary refusal.
 */
export function isCheckViolation(error: unknown, constraint: string): boolean {
  if (sqlStateOf(error) !== CHECK_VIOLATION) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(constraint);
}
