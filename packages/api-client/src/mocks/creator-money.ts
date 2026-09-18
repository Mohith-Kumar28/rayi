import { http, HttpResponse, delay } from 'msw';

import { DEAL_ID, DEAL_ID_2, scenario, usd } from './core.js';

/**
 * The creator's money.
 *
 * The fixtures are chosen so the three figures on the creator's home screen
 * reconcile against this list rather than merely looking plausible: paid out
 * ($600) is the one `paid` payout, awaiting the next run ($625) is the one
 * `scheduled` payout, and neither includes anything merely approved.
 */

const PAYOUTS = [
  {
    payoutId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
    amount: usd('62500'),
    state: 'scheduled' as const,
    batchId: null,
    // An ESTIMATE, and labelled as one on screen. Never a promised weekday.
    expectedArrivalAt: '2026-09-22T00:00:00.000Z',
    paidAt: null,
    reason: null,
    sources: [
      {
        dealId: DEAL_ID_2,
        brandName: 'Coil & Co',
        milestoneTitle: 'Halfway',
        amount: usd('62500'),
      },
    ],
  },
  {
    payoutId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
    amount: usd('60000'),
    state: 'paid' as const,
    batchId: 'ffffffff-ffff-4fff-8fff-fffffffffb01',
    expectedArrivalAt: '2026-09-01T00:00:00.000Z',
    paidAt: '2026-09-01T09:14:00.000Z',
    reason: null,
    sources: [
      {
        dealId: DEAL_ID,
        brandName: 'Lumen Skincare',
        milestoneTitle: 'On signing',
        amount: usd('60000'),
      },
    ],
  },
  {
    /*
     * Held, with a reason written FOR the creator.
     *
     * "Your payouts are paused for 72 hours because the bank details changed" is
     * something a person can act on. A status code is something they contact
     * support about — at exactly the moment support cannot distinguish them from
     * whoever changed the details.
     */
    payoutId: 'ffffffff-ffff-4fff-8fff-fffffffffff3',
    amount: usd('30000'),
    state: 'held' as const,
    batchId: null,
    expectedArrivalAt: null,
    paidAt: null,
    reason:
      'Paused until 20 Sep because your bank details changed on 17 Sep. If that was not you, use ' +
      'the stop link in the email we sent to your previous address.',
    sources: [
      {
        dealId: DEAL_ID,
        brandName: 'Lumen Skincare',
        milestoneTitle: 'After 10 videos',
        amount: usd('30000'),
      },
    ],
  },
];

const DESTINATION = {
  last4: '4412',
  bankName: 'Chase',
  payoutsEnabled: true,
  pendingRequirements: [],
  holdUntil: '2026-09-20T14:00:00.000Z',
  lastChangedAt: '2026-09-17T14:00:00.000Z',
};

/** Onboarding done, verification not. Saying "ready" here would be the worst lie available. */
const DESTINATION_PENDING = {
  last4: null,
  bankName: null,
  payoutsEnabled: false,
  pendingRequirements: [
    'Confirm your date of birth',
    'Upload a government photo ID',
    'Add a bank account',
  ],
  holdUntil: null,
  lastChangedAt: null,
};

const PROFILE = {
  handle: '@mayaonmain',
  displayName: 'Maya Oyelaran',
  bio: 'Skincare and everyday routines. Lagos → London.',
  avatarUrl: null,
  email: 'maya@example.com',
  twoFactorEnabled: false,
  publicUrl: null,
};

export const creatorMoneyHandlers = [
  http.get('*/api/v1/me/payouts', async () => {
    await delay(190);
    if (scenario() === 'empty') {
      return HttpResponse.json({
        payouts: [],
        awaitingNextRun: usd('0'),
        nextRunAt: null,
      });
    }
    return HttpResponse.json({
      payouts: PAYOUTS,
      awaitingNextRun: usd('62500'),
      nextRunAt: '2026-09-22T00:00:00.000Z',
    });
  }),

  http.get('*/api/v1/me/payout-destination', async () => {
    await delay(160);
    return HttpResponse.json(scenario() === 'empty' ? DESTINATION_PENDING : DESTINATION);
  }),

  http.post('*/api/v1/me/payout-destination', async () => {
    await delay(480);
    return HttpResponse.json({
      onboardingUrl: 'https://connect.stripe.com/setup/e/mock_session',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      // Said BEFORE they start, not after. A creator who does not know a change
      // pauses payouts for three days reads the hold as the product being broken.
      holdHours: 72,
    });
  }),

  http.get('*/api/v1/me/creator-profile', async () => {
    await delay(150);
    return HttpResponse.json(PROFILE);
  }),
];
