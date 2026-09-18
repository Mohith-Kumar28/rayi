import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The transaction-purity guard.
 *
 * Roughly twenty lines that prevent the failure which actually costs money:
 * calling Stripe (or any other external system) from inside an open database
 * transaction.
 *
 * Why it matters. A ledger transaction may be retried — on a serialization
 * failure, a deadlock, or a lock timeout. If a Stripe call happened inside it,
 * the retry calls Stripe AGAIN, and the second call is a second transfer. The
 * database rolls back; Stripe does not.
 *
 * It is also the slowest possible place to make a network call: the transaction
 * holds its row locks for the entire round trip, so every other posting against
 * those accounts queues behind an HTTP request to a third party.
 *
 * The rule this enforces: **a database transaction contains only database work.**
 * External effects are enqueued inside the transaction as a job row and
 * performed afterwards by the worker.
 */

const transactionDepth = new AsyncLocalStorage<{
  depth: number;
  label: string;
}>();

export class ExternalCallInTransactionError extends Error {
  readonly code = 'EXTERNAL_CALL_IN_TRANSACTION';

  constructor(operation: string, label: string) {
    super(
      `Refusing to perform "${operation}" inside the open ledger transaction "${label}". ` +
        `A transaction can be retried, and a retried external call is a duplicate side effect — ` +
        `on the money path that is a second Stripe transfer. Enqueue the work inside the ` +
        `transaction instead and let the worker perform it after commit.`,
    );
    this.name = 'ExternalCallInTransactionError';
  }
}

/** Marks a region as an open database transaction. Nesting is tracked. */
export function runInTransactionScope<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = transactionDepth.getStore();
  return transactionDepth.run({ depth: (current?.depth ?? 0) + 1, label }, fn);
}

export function isInsideTransaction(): boolean {
  return (transactionDepth.getStore()?.depth ?? 0) > 0;
}

/**
 * Call at the top of anything that performs an external side effect — every
 * Stripe gateway method, the notification sender, any outbound HTTP client.
 *
 * Deliberately a runtime check rather than a lint rule: the call may be many
 * frames below the transaction, through an interface the caller cannot see, and
 * static analysis cannot follow that.
 */
export function assertNoOpenTransaction(operation: string): void {
  const store = transactionDepth.getStore();
  if (store && store.depth > 0) {
    throw new ExternalCallInTransactionError(operation, store.label);
  }
}
