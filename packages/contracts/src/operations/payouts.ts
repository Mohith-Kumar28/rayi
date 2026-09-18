import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The creator's money — payouts and where they go.
 *
 * **This is the most dangerous surface in the product for the population it
 * serves.** Every control built so far protects brands. Creators are
 * passwordless, often have no second factor, and their entire permission set is
 * "be paid" — so a hijacked creator session is not "an authenticated session and
 * nothing more", it is a session that can redirect someone's income.
 *
 * Three consequences, all visible in the shapes below:
 *
 * **Binding a payout destination is a money-moving action**, not a settings
 * change. It needs step-up, it is rate-limited per creator, and it notifies BOTH
 * the old and the new contact details — where the stop action requires the code
 * from the message sent to the OLD one.
 *
 * **Rebinds route through Stripe's own onboarding**, so Stripe's identity checks
 * are the second factor. Rayi never accepts bank details directly: there is no
 * field here that takes an account number, and there must never be one.
 *
 * **Every change starts a hold.** 72 hours, with instant payout disabled during
 * it. `account.updated` with changed external accounts is the only signal Rayi
 * gets, and a hold is what turns it from a notification into a recovery window.
 */

export const PayoutStateSchema = z.enum([
  'scheduled',
  'in_transit',
  'paid',
  'failed',
  'held',
  'cancelled',
]);

export const PayoutSchema = z.object({
  payoutId: z.uuid(),
  amount: MoneySchema,
  state: PayoutStateSchema,
  /**
   * The batch this belongs to. Payouts are weekly and batched, so a creator sees
   * one arrival rather than one per milestone.
   */
  batchId: z.uuid().nullable(),
  /**
   * When it is EXPECTED to arrive — an estimate from the payment provider, and
   * described as one.
   *
   * Never rendered as a promise and never as a weekday. "Paid out Friday.
   * Always." is a sentence the product cannot keep, and the one time it is wrong
   * is the time somebody has rent due.
   */
  expectedArrivalAt: z.iso.datetime().nullable(),
  /** When the money actually left. Null until it has. */
  paidAt: z.iso.datetime().nullable(),
  /** Set only on `failed` or `held`, and written for the creator, not for us. */
  reason: z.string().nullable(),
  /** Which deals fed this payout, so a creator can reconcile it themselves. */
  sources: z.array(
    z.object({
      dealId: z.uuid(),
      brandName: z.string(),
      milestoneTitle: z.string(),
      amount: MoneySchema,
    }),
  ),
});

export const getMyPayouts = defineOperation({
  operationId: 'getMyPayouts',
  method: 'get',
  path: '/v1/me/payouts',
  summary: 'Your payouts',
  description:
    'Scoped by the session user id in the WHERE clause. There is no creator id in this path and ' +
    'there must never be one.',
  tags: ['payouts'],
  access: { kind: 'self' },
  successStatus: 200,
  response: z.object({
    payouts: z.array(PayoutSchema),
    /** Released and waiting for the next run. Real money, not yet moved. */
    awaitingNextRun: MoneySchema,
    nextRunAt: z.iso.datetime().nullable(),
  }),
  errors: ['unauthenticated'],
});

export const PayoutDestinationSchema = z.object({
  /** Null until the creator has completed onboarding with the payment provider. */
  last4: z.string().length(4).nullable(),
  bankName: z.string().nullable(),
  /**
   * Whether the provider will actually pay out.
   *
   * Comes from the provider, never inferred from "they finished the form" —
   * onboarding can complete while verification is still outstanding, and telling
   * a creator they are ready to be paid when they are not is the worst available
   * lie on this screen.
   */
  payoutsEnabled: z.boolean(),
  /** Outstanding requirements, in the provider's words, so support can act on them. */
  pendingRequirements: z.array(z.string()),
  /**
   * The 72-hour hold after a destination change.
   *
   * Notified to the OLD contact details. A hijacked session that rebinds the
   * bank account therefore cannot also collect, and the real creator has three
   * days and a stop link to act.
   */
  holdUntil: z.iso.datetime().nullable(),
  lastChangedAt: z.iso.datetime().nullable(),
});

export const getMyPayoutDestination = defineOperation({
  operationId: 'getMyPayoutDestination',
  method: 'get',
  path: '/v1/me/payout-destination',
  summary: 'Where your money goes',
  description:
    'Returns the last four digits and the provider’s verification state. Never a full account ' +
    'number, never a token a client could reuse.',
  tags: ['payouts'],
  access: { kind: 'self' },
  successStatus: 200,
  response: PayoutDestinationSchema,
  errors: ['unauthenticated'],
});

export const startPayoutDestinationChange = defineOperation({
  operationId: 'startPayoutDestinationChange',
  method: 'post',
  path: '/v1/me/payout-destination',
  summary: 'Start changing where your money goes',
  description:
    'Returns a single-use, short-lived link to the payment provider’s own onboarding. Rayi ' +
    'never accepts bank details directly, so the provider’s identity checks are the second ' +
    'factor — and both the old and the new contact details are notified before anything changes.',
  tags: ['payouts'],
  access: { kind: 'self', stepUp: true },
  body: z.object({ code: z.string().min(6).max(12) }),
  successStatus: 200,
  response: z.object({
    /** Single-use and short-lived. Minting one is itself an audited money action. */
    onboardingUrl: z.url(),
    expiresAt: z.iso.datetime(),
    /**
     * What will happen when they finish, said before they start.
     *
     * A creator who does not know a change pauses their payouts for three days
     * will read the hold as the product being broken, and will contact support
     * at exactly the moment support cannot distinguish them from an attacker.
     */
    holdHours: z.int(),
  }),
  errors: ['unauthenticated', 'step_up_required', 'rate_limited', 'conflict'],
});

export const CreatorProfileSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  email: z.email(),
  /** Whether a second factor is enrolled. Offered after first payout, required for rebinds. */
  twoFactorEnabled: z.boolean(),
  /** The public page, if they have published one. */
  publicUrl: z.url().nullable(),
});

export const getMyCreatorProfile = defineOperation({
  operationId: 'getMyCreatorProfile',
  method: 'get',
  path: '/v1/me/creator-profile',
  summary: 'Your creator profile',
  tags: ['payouts'],
  access: { kind: 'self' },
  successStatus: 200,
  response: CreatorProfileSchema,
  errors: ['unauthenticated'],
});

export const PAYOUT_OPERATIONS = [
  getMyPayouts,
  getMyPayoutDestination,
  startPayoutDestinationChange,
  getMyCreatorProfile,
] as const;
