import { http, HttpResponse, delay } from 'msw';

import type { Problem } from '@rayi/contracts';

/**
 * Hand-written mock scenarios.
 *
 * Deliberately NOT orval's generated Faker mocks. Random money is actively
 * harmful in a money UI: it hides alignment bugs, makes a screenshot
 * unreviewable, and means nobody ever sees the same number twice. These
 * fixtures are stable and chosen to exercise the cases that break layouts —
 * a six-figure balance, an exact-cents amount, a zero, and a lot still
 * clearing.
 *
 * Handler paths are host-wildcarded so the same handlers work in the browser
 * worker and in the Node test server, where there is no page origin for a
 * relative path to resolve against.
 *
 * Switch scenario at runtime from the browser console:
 *   window.__rayiScenario = 'insufficient-funds'
 */

export type MockScenario =
  | 'default'
  | 'insufficient-funds'
  | 'step-up-required'
  | 'idempotency-conflict'
  | 'empty';

declare global {
  // eslint-disable-next-line no-var
  var __rayiScenario: MockScenario | undefined;
}

function scenario(): MockScenario {
  return globalThis.__rayiScenario ?? 'default';
}

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';

const usd = (amountMinor: string) => ({ amountMinor, currency: 'USD' as const, exponent: 2 });

/** $412,500.00 available, $50,000 still clearing, $9,800 pending, $137,250.50 allocated. */
const FUNDS = {
  orgId: ORG_ID,
  available: usd('41250000'),
  clearing: usd('5000000'),
  pending: usd('980000'),
  allocated: usd('13725050'),
  lots: [
    {
      depositId: '33333333-3333-4333-8333-333333333331',
      available: usd('25000000'),
      settledAt: '2026-09-02T14:12:00.000Z',
      maturesAt: '2026-09-04T14:12:00.000Z',
      fundedAt: '2026-08-29T09:30:00.000Z',
    },
    {
      depositId: '33333333-3333-4333-8333-333333333332',
      available: usd('16250000'),
      settledAt: '2026-09-09T16:40:00.000Z',
      maturesAt: '2026-09-11T16:40:00.000Z',
      fundedAt: '2026-09-05T11:05:00.000Z',
    },
    {
      // Settled but inside its ACH return window — visible, not yet releasable.
      depositId: '33333333-3333-4333-8333-333333333333',
      available: usd('5000000'),
      settledAt: '2026-09-17T08:00:00.000Z',
      maturesAt: '2026-11-17T08:00:00.000Z',
      fundedAt: '2026-09-13T13:20:00.000Z',
    },
    {
      // Still with the bank. Lives in a memo account and can never be allocated.
      depositId: '33333333-3333-4333-8333-333333333334',
      available: usd('980000'),
      settledAt: null,
      maturesAt: null,
      fundedAt: '2026-09-17T19:45:00.000Z',
    },
  ],
};

const EMPTY_FUNDS = {
  orgId: ORG_ID,
  available: usd('0'),
  clearing: usd('0'),
  pending: usd('0'),
  allocated: usd('0'),
  lots: [],
};

const CAMPAIGNS = {
  campaigns: [
    {
      campaignId: CAMPAIGN_ID,
      workspaceId: '44444444-4444-4444-8444-444444444441',
      name: 'Skincare — Q4 launch',
      state: 'live' as const,
      allocated: usd('7500000'),
      released: usd('4182050'),
      deliverablesTotal: 240,
      deliverablesApproved: 137,
    },
    {
      campaignId: '22222222-2222-4222-8222-222222222223',
      workspaceId: '44444444-4444-4444-8444-444444444441',
      name: 'Haircare — always-on',
      state: 'live' as const,
      allocated: usd('4225050'),
      released: usd('3100000'),
      deliverablesTotal: 120,
      deliverablesApproved: 96,
    },
    {
      campaignId: '22222222-2222-4222-8222-222222222224',
      workspaceId: '44444444-4444-4444-8444-444444444442',
      name: 'UK market test',
      state: 'draft' as const,
      allocated: usd('0'),
      released: usd('0'),
      deliverablesTotal: 40,
      deliverablesApproved: 0,
    },
  ],
};

function problem(init: Omit<Problem, 'type' | 'requestId'> & { type?: string }): Problem {
  return {
    type: init.type ?? 'about:blank',
    requestId: 'req_mock_0000000000',
    ...init,
  } as Problem;
}

const PROBLEMS: Record<string, Problem> = {
  'insufficient-funds': problem({
    title: 'Not enough available funds',
    status: 409,
    code: 'insufficient_unallocated_funds',
    detail:
      'This allocation exceeds the funds that have settled and cleared their return window. ' +
      '$50,000.00 is still clearing and becomes available on 11 Sep.',
  }),
  'step-up-required': problem({
    title: 'Confirm it is you',
    status: 403,
    code: 'step_up_required',
    detail: 'Allocating this amount needs a fresh security check.',
    challenge: {
      challengeId: 'chal_mock_01',
      reason: 'amount_above_threshold',
      expiresAt: '2030-01-01T00:00:00.000Z',
    },
  }),
  'idempotency-conflict': problem({
    title: 'Already submitted',
    status: 409,
    code: 'idempotency_key_reused',
    detail: 'This allocation was already accepted. Refreshing does not submit it twice.',
  }),
};

export const handlers = [
  http.get('*/api/v1/orgs/:orgId/funds', async () => {
    await delay(220);
    return HttpResponse.json(scenario() === 'empty' ? EMPTY_FUNDS : FUNDS);
  }),

  http.get('*/api/v1/orgs/:orgId/campaigns', async () => {
    await delay(180);
    return HttpResponse.json(scenario() === 'empty' ? { campaigns: [] } : CAMPAIGNS);
  }),

  http.post('*/api/v1/orgs/:orgId/campaigns/:campaignId/allocations', async ({ params }) => {
    await delay(400);
    const current = scenario();
    const failure = PROBLEMS[current];
    if (failure) {
      return HttpResponse.json(failure, {
        status: failure.status,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(
      {
        commandId: '55555555-5555-4555-8555-555555555555',
        status: 'accepted' as const,
        campaignId: String(params['campaignId']),
      },
      { status: 202 },
    );
  }),
];

export const MOCK_IDS = { ORG_ID, CAMPAIGN_ID };
export const MOCK_SCENARIOS: MockScenario[] = [
  'default',
  'insufficient-funds',
  'step-up-required',
  'idempotency-conflict',
  'empty',
];
