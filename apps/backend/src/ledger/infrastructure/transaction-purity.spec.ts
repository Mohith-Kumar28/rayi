import {
  assertNoOpenTransaction,
  ExternalCallInTransactionError,
  isInsideTransaction,
  runInTransactionScope,
} from './transaction-purity';

/**
 * These tests protect the single most expensive mistake available on the money
 * path: calling Stripe from inside a database transaction. The transaction can
 * be retried; the Stripe call cannot be un-made.
 */
describe('transaction purity', () => {
  it('permits an external call outside a transaction', () => {
    expect(() =>
      assertNoOpenTransaction('stripe.transfers.create'),
    ).not.toThrow();
    expect(isInsideTransaction()).toBe(false);
  });

  it('refuses an external call inside a transaction', async () => {
    await runInTransactionScope('post_entry:RELEASE', async () => {
      expect(isInsideTransaction()).toBe(true);
      expect(() => assertNoOpenTransaction('stripe.transfers.create')).toThrow(
        ExternalCallInTransactionError,
      );
    });
  });

  it('names the operation AND the transaction, so the fix is obvious', async () => {
    await runInTransactionScope('post_entry:RELEASE', async () => {
      try {
        assertNoOpenTransaction('stripe.transfers.create');
        throw new Error('should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('stripe.transfers.create');
        expect(message).toContain('post_entry:RELEASE');
        // The message must explain WHY, or someone will delete the guard.
        expect(message).toContain('retried');
      }
    });
  });

  it('catches a call many frames below the transaction', async () => {
    // The realistic shape: the transaction is opened in a repository, and the
    // Stripe call happens inside a service three layers down, behind an
    // interface the caller cannot see. No lint rule can follow that.
    const deeplyNestedStripeCall = () =>
      assertNoOpenTransaction('stripe.transfers.create');
    const serviceLayer = async () => deeplyNestedStripeCall();
    const useCase = async () => serviceLayer();

    await runInTransactionScope('post_entry:RELEASE', async () => {
      await expect(useCase()).rejects.toThrow(ExternalCallInTransactionError);
    });
  });

  it('restores the outer state after the transaction closes', async () => {
    await runInTransactionScope('tx', async () => {
      expect(isInsideTransaction()).toBe(true);
    });
    expect(isInsideTransaction()).toBe(false);
  });

  it('still refuses inside a nested transaction', async () => {
    await runInTransactionScope('outer', async () => {
      await runInTransactionScope('inner', async () => {
        expect(() => assertNoOpenTransaction('notify')).toThrow(
          ExternalCallInTransactionError,
        );
      });
      // Leaving the inner scope must not clear the outer one.
      expect(isInsideTransaction()).toBe(true);
    });
  });

  it('survives an await boundary — AsyncLocalStorage, not a plain flag', async () => {
    await runInTransactionScope('tx', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(isInsideTransaction()).toBe(true);
    });
  });
});
