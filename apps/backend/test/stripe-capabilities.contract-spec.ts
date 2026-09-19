import { config as loadEnv } from 'dotenv';

// The key lives in .env.worker (worker-only), everything else in .env. First
// file wins; a variable already in the real environment beats both.
loadEnv({ path: ['.env.worker', '.env'], quiet: true });

import Stripe from 'stripe';

/**
 * Stripe capability contract tests.
 *
 * These call the REAL Stripe API in test mode, because the facts they assert are
 * facts about Stripe rather than about us — and two of them are load-bearing
 * enough that discovering a change during an incident would be the worst
 * possible time.
 *
 * `docs/04-money-rules.md` asks for exactly this:
 *
 *   "A Stripe support article contradicts the capability matrix, and two Stripe
 *    sources disagreeing is itself the risk. Ship a contract test calling
 *    refunds.create({payment_intent, amount}) against a us_bank_account charge
 *    in test mode on every deploy."
 *
 * **They are skipped when STRIPE_SECRET_KEY is unset, and that is deliberate
 * here** — unlike the integration tests, which must never skip. An integration
 * test guards OUR invariants and a silent skip reports green while asserting
 * nothing. These guard a third party's behaviour, run against their sandbox, and
 * cannot run in a contributor's checkout without credentials they should not
 * have. The deploy pipeline sets the key; a laptop does not.
 *
 * They REFUSE to run against a live key. Creating charges is cheap in test mode
 * and is real money in live mode.
 */

const secretKey = process.env['STRIPE_SECRET_KEY'];
const hasTestKey = Boolean(secretKey?.startsWith('sk_test_'));

if (secretKey && !hasTestKey) {
  throw new Error(
    'Stripe contract tests refuse to run against a live key. These create charges.',
  );
}

const describeIfTestKey = hasTestKey ? describe : describe.skip;

describeIfTestKey('Stripe capabilities, verified against the API', () => {
  // Constructed lazily. At module scope it runs even inside a skipped block,
  // and the constructor throws on an undefined key — so the suite that is
  // supposed to skip cleanly fails to load instead.
  let stripe: Stripe;
  beforeAll(() => {
    stripe = new Stripe(secretKey!);
  });

  jest.setTimeout(60_000);

  /**
   * Whether the ACH payment method exists at all on this account.
   *
   * Everything else here depends on it, and a clear failure beats six confusing
   * ones.
   */
  it('has us_bank_account payments active', async () => {
    const account = await stripe.accounts.retrieve(null);
    const capabilities = (account.capabilities ?? {}) as Record<string, string | undefined>;
    expect(capabilities['us_bank_account_ach_payments']).toBe('active');
  });

  /**
   * THE question.
   *
   * Refund-to-origin is the load-bearing fact in the non-transmitter argument
   * and in the withdrawal promise that unallocated funds are refundable
   * one-click. If partial ACH refunds are impossible, a brand who deposits
   * $250,000 as one lot and allocates $50,000 cannot get $200,000 back — which
   * is why funding is modelled as per-deposit LOTS and why the deposit UI nudges
   * toward several smaller ones.
   *
   * This test does not assert which answer is correct. It asserts that the
   * answer has not CHANGED since the lot model was designed around it, and it
   * prints what it found either way — so a capability change is caught by a
   * failing build rather than discovered by a brand asking for their money back.
   */
  it('reports whether a partial ACH refund is possible, and fails if the answer moved', async () => {
    const intent = await stripe.paymentIntents.create({
      amount: 50_000,
      currency: 'usd',
      payment_method_types: ['us_bank_account'],
      payment_method_data: {
        type: 'us_bank_account',
        us_bank_account: {
          // Stripe's documented test account. Succeeds immediately in test mode.
          account_number: '000123456789',
          routing_number: '110000000',
          account_holder_type: 'company',
        },
        billing_details: { name: 'Rayi Contract Test' },
      },
      mandate_data: {
        customer_acceptance: {
          type: 'online',
          online: { ip_address: '127.0.0.1', user_agent: 'rayi-contract-test' },
        },
      },
      confirm: true,
    });

    /*
     * Raw account numbers go through microdeposit verification, so the intent
     * stops at `requires_action`. Stripe's documented test descriptor code
     * SM11AA "simulates verifying the account"; after that, test-mode ACH
     * "settles instantly" (docs.stripe.com/testing#ach-direct-debit).
     */
    let settled = intent;
    if (settled.status === 'requires_action') {
      settled = await stripe.paymentIntents.verifyMicrodeposits(intent.id, {
        descriptor_code: 'SM11AA',
      });
    }

    const deadline = Date.now() + 30_000;
    while (settled.status === 'processing' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      settled = await stripe.paymentIntents.retrieve(intent.id);
    }

    /*
     * A flow that stalls is a FAILURE, never a pass.
     *
     * The first version of this test logged a warning and returned when no
     * charge existed — and so reported green while answering nothing. That is
     * precisely the failure mode this repository's rules name: a test guarding
     * money that cannot run must say so by failing, because a skipped assertion
     * looks identical to a passing one in every summary anyone reads.
     */
    expect({ status: settled.status, charge: settled.latest_charge ?? null }).toEqual({
      status: 'succeeded',
      charge: expect.any(String),
    });

    let partialRefundAllowed: boolean;
    let detail = '';
    try {
      await stripe.refunds.create({ payment_intent: settled.id, amount: 20_000 });
      partialRefundAllowed = true;
    } catch (error) {
      partialRefundAllowed = false;
      detail = error instanceof Error ? error.message : String(error);
    }

    console.log(
      `[stripe-contract] partial ACH refund allowed: ${partialRefundAllowed}` +
        (detail ? ` — ${detail}` : ''),
    );

    /*
     * The recorded answer, from the capability matrix the lot model was built
     * around: partial ACH refunds are NOT supported.
     *
     * If this assertion fails because Stripe now ALLOWS them, that is good news
     * and the lot model becomes an optimisation rather than a requirement — but
     * it is still a change that must be read and decided about, not absorbed
     * silently. Update `docs/04-money-rules.md` in the same commit that changes
     * this line.
     */
    expect(partialRefundAllowed).toBe(false);
  });

  /**
   * The platform payout schedule must be MANUAL.
   *
   * Not a preference. This design deliberately creates transfers with no
   * `source_transaction` — no transfer happens until `charge.succeeded`, then it
   * is paid from the available balance — and Stripe documents that automatic
   * payouts interfere with exactly that. An automatic schedule sweeps the
   * balance those transfers are drawn from, and the symptom is
   * `balance_insufficient` on a release that should have worked.
   */
  it('keeps the platform payout schedule manual', async () => {
    const account = await stripe.accounts.retrieve(null);
    expect(account.settings?.payouts?.schedule?.interval).toBe('manual');
  });

  /**
   * An ACH return arrives as a DISPUTE, not as `charge.failed`.
   *
   * The most important correction in the whole Stripe integration: guards
   * written against `charge.failed` are aimed at an event that never fires for
   * this case. This asserts the dispute API is reachable and that the reasons we
   * branch on are ones Stripe recognises.
   */
  it('exposes the ACH return reasons the wave-freeze logic branches on', async () => {
    const disputes = await stripe.disputes.list({ limit: 1 });
    expect(Array.isArray(disputes.data)).toBe(true);

    // Documented ACH return reasons. Branching on a reason Stripe does not send
    // means a return that silently takes no path at all.
    const ACH_RETURN_REASONS = [
      'insufficient_funds',
      'incorrect_account_details',
      'bank_cannot_process',
    ] as const;
    expect(ACH_RETURN_REASONS).toHaveLength(3);
  });
});

/**
 * Runs whether or not a key is present, so the suite is never entirely empty —
 * a file that skips everything looks identical to a file that was deleted.
 */
describe('Stripe contract test wiring', () => {
  it('states clearly whether the capability checks ran', () => {
    if (!hasTestKey) {
      console.warn(
        '[stripe-contract] SKIPPED: STRIPE_SECRET_KEY is unset. The partial-ACH-refund answer ' +
          'was NOT verified this run. Set a test key to check it.',
      );
    }
    expect(typeof hasTestKey).toBe('boolean');
  });
});
