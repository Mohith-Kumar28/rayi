/**
 * Retry-on-transient-database-failure.
 *
 * ALL knowledge of database error codes lives in this one file. That is
 * deliberate: Prisma's `P####` codes change across majors — Prisma 8 removes
 * them entirely — so confining them here makes the eventual upgrade a one-file
 * change rather than a hunt through the money path.
 *
 * Two rules matter more than the retry itself:
 *
 *  1. **Never retry a transaction that performed an external side effect.**
 *     Enforced separately by the transaction-purity guard, because a retried
 *     Stripe call is a duplicate transfer.
 *
 *  2. **Distinguish a serialization failure from a constraint violation.** They
 *     can surface identically through a client wrapper. A serialization failure
 *     is transient and should be retried; an unbalanced entry or an overdraft is
 *     a *correct* refusal and must fail loudly. Retrying it five times before
 *     dead-lettering turns a clear error into a confusing one.
 */

/** Transient. The transaction can be replayed and may succeed. */
const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

/**
 * NOT transient. These mean the database refused something it was right to
 * refuse — an overdraft, an unbalanced entry, a duplicate posting.
 */
const TERMINAL_SQLSTATES = new Set([
  '23514', // check_violation        — overdraft, unbalanced entry, non-positive amount
  '23505', // unique_violation       — idempotency key already used
  '23503', // foreign_key_violation  — unknown account
  '0A000', // feature_not_supported  — our append-only triggers raise this
]);

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
      if (typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value))
        return value;
    }
    current = candidate.cause;
  }
  return undefined;
}

export function isRetryable(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state === undefined) return false;
  if (TERMINAL_SQLSTATES.has(state)) return false;
  return RETRYABLE_SQLSTATES.has(state);
}

export function isTerminal(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && TERMINAL_SQLSTATES.has(state);
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  /** Injected so tests do not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` on transient database failures with full jitter.
 *
 * Full jitter rather than plain exponential backoff: when a burst of postings
 * contends on one hot account — a thousand deliverables releasing in a window —
 * fixed backoff makes them all retry in lockstep and collide again.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 20;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error;
      }

      options.onRetry?.(attempt, error);

      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.floor(Math.random() * ceiling));
    }
  }

  throw lastError;
}
