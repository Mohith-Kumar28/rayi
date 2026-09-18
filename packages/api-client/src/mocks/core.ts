import { http, HttpResponse, delay } from 'msw';

import { checkDefinition } from '@rayi/domain';

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
  | 'ledger-drift'
  | 'empty';

declare global {
  // eslint-disable-next-line no-var
  var __rayiScenario: MockScenario | undefined;
}

export function scenario(): MockScenario {
  return globalThis.__rayiScenario ?? 'default';
}

export const ORG_ID = '11111111-1111-4111-8111-111111111111';
export const CAMPAIGN_ID = '22222222-2222-4222-8222-222222222222';

export const usd = (amountMinor: string) => ({ amountMinor, currency: 'USD' as const, exponent: 2 });

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

export function problem(init: Omit<Problem, 'type' | 'requestId'> & { type?: string }): Problem {
  return {
    type: init.type ?? 'about:blank',
    requestId: 'req_mock_0000000000',
    ...init,
  } as Problem;
}

export const PROBLEMS: Record<string, Problem> = {
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

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export const DEAL_ID = '66666666-6666-4666-8666-666666666661';
export const DEAL_ID_2 = '66666666-6666-4666-8666-666666666662';

/**
 * A check result, with `label` and `tier` taken from the real catalogue rather
 * than typed out here. A fixture that invents its own labels is a fixture that
 * shows a screen the server can never actually produce.
 */
const check = (name: string, status: 'PASS' | 'FAIL' | 'ERROR', detail: string | null = null) => {
  const definition = checkDefinition(name);
  return { name, label: definition.label, tier: definition.tier, status, detail };
};

const pass = (name: string) => check(name, 'PASS');

/**
 * Four exceptions, chosen to exercise every branch the reviewer can hit:
 * a blocking FAIL, an ERROR that must read "could not verify" and never punish
 * the creator, an advisory FAIL that still releases money, and a clean row that
 * is an exception ONLY because approving it moves money.
 */
const QUEUE_ROWS = [
  {
    submissionId: '77777777-7777-4777-8777-777777777771',
    deliverableId: '88888888-8888-4888-8888-888888888871',
    dealId: DEAL_ID,
    campaignName: 'Skincare — Q4 launch',
    creatorHandle: '@mayaonmain',
    slot: 'Video 4 of 20',
    submissionVersion: 2,
    submittedAt: '2026-09-18T07:12:00.000Z',
    caption: 'day 14 of the barrier repair thing and my cheeks have stopped peeling 😭 #ad',
    previewUrl: null,
    checks: [
      check(
        'disclosure',
        'FAIL',
        'No #ad or Paid partnership label found in the caption or the first frame.',
      ),
      pass('duration'),
      pass('resolution'),
      pass('duplicate'),
    ],
    releasesOnApproval: null,
  },
  {
    submissionId: '77777777-7777-4777-8777-777777777772',
    deliverableId: '88888888-8888-4888-8888-888888888872',
    dealId: DEAL_ID,
    campaignName: 'Skincare — Q4 launch',
    creatorHandle: '@thekwongs',
    slot: 'Video 11 of 20',
    submissionVersion: 1,
    submittedAt: '2026-09-18T06:40:00.000Z',
    caption: 'the 3-step routine my dermatologist actually approved of. #ad',
    previewUrl: null,
    checks: [
      pass('disclosure'),
      // ERROR is not FAIL. ffprobe fell over; that is our infrastructure
      // failing, not the creator, so the row goes to review rather than back.
      check(
        'duration',
        'ERROR',
        'The media probe did not finish. Nothing is wrong with the video as far as we know.',
      ),
      pass('resolution'),
    ],
    releasesOnApproval: null,
  },
  {
    submissionId: '77777777-7777-4777-8777-777777777773',
    deliverableId: '88888888-8888-4888-8888-888888888873',
    dealId: DEAL_ID_2,
    campaignName: 'Haircare — always-on',
    creatorHandle: '@priyacuts',
    slot: 'Video 12 of 12',
    submissionVersion: 1,
    submittedAt: '2026-09-17T18:02:00.000Z',
    caption: 'final one of the series — the full 12 week before and after. #ad #sponsored',
    previewUrl: null,
    checks: [
      pass('disclosure'),
      pass('duration'),
      pass('resolution'),
      check('duplicate', 'FAIL', 'A near-identical clip appeared in Skincare — Q4 launch on 2 Sep.'),
    ],
    // Approving this completes the deal's last milestone. It is money, and it
    // is an exception for that reason alone.
    releasesOnApproval: usd('180000'),
  },
  {
    submissionId: '77777777-7777-4777-8777-777777777774',
    deliverableId: '88888888-8888-4888-8888-888888888874',
    dealId: DEAL_ID_2,
    campaignName: 'Haircare — always-on',
    creatorHandle: '@devonmakes',
    slot: 'Video 5 of 10',
    submissionVersion: 1,
    submittedAt: '2026-09-17T15:30:00.000Z',
    caption: 'okay the curl cream is doing something. week 2. #ad',
    previewUrl: null,
    checks: [
      pass('disclosure'),
      pass('duration'),
      pass('resolution'),
      pass('duplicate'),
    ],
    // Every check passed. It is here because it tips a 5-video milestone.
    releasesOnApproval: usd('62500'),
  },
];

const CLEARED_IDS = Array.from(
  { length: 23 },
  (_, i) => `99999999-9999-4999-8999-${String(i + 1).padStart(12, '0')}`,
);

/**
 * In-memory queue state, so approve and undo actually do something.
 *
 * A mock that returns the same four rows however you act on them cannot show
 * whether the releasing lane, the countdown or the undo path work — which is
 * the entire reason the queue screen was built the way it was.
 */
const decided = new Set<string>();
const reviewToSubmission = new Map<string, string>();

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

const milestone = (
  id: string,
  title: string,
  amountMinor: string,
  satisfied: boolean,
  reason: string,
  releasedAt: string | null,
) => ({ milestoneId: id, title, amount: usd(amountMinor), satisfied, reason, releasedAt });

const CREATOR_DEALS = [
  {
    dealId: DEAL_ID,
    brandName: 'Lumen Skincare',
    campaignName: 'Skincare — Q4 launch',
    state: 'active' as const,
    total: usd('240000'),
    earned: usd('60000'),
    milestones: [
      milestone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'On signing',
        '60000',
        true,
        'Paid when you accepted the deal.',
        '2026-08-30T12:04:00.000Z',
      ),
      milestone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        'After 10 videos',
        '90000',
        false,
        '3 more videos need to be approved (7 of 10 so far).',
        null,
      ),
      milestone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        'On completion',
        '90000',
        false,
        '13 more videos need to be approved (7 of 20 so far).',
        null,
      ),
    ],
    deliverables: [
      {
        deliverableId: '88888888-8888-4888-8888-888888888871',
        slot: 'Video 4 of 20',
        state: 'in_review' as const,
        brief: 'Barrier repair, 30–45s, show the texture.',
        latestVersion: 2,
        latestComment: 'Closer — can you say the product name out loud in the first five seconds?',
      },
      {
        deliverableId: '88888888-8888-4888-8888-888888888875',
        slot: 'Video 8 of 20',
        state: 'changes_requested' as const,
        brief: 'Morning routine, vertical, under 60s.',
        latestVersion: 1,
        latestComment: 'The disclosure needs to be in the caption, not only in the voiceover.',
      },
      {
        deliverableId: '88888888-8888-4888-8888-888888888876',
        slot: 'Video 9 of 20',
        state: 'pending' as const,
        brief: 'Night routine. Free rein on the hook.',
        latestVersion: 0,
        latestComment: null,
      },
    ],
    nextUnlock: milestone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      'After 10 videos',
      '90000',
      false,
      '3 more videos need to be approved (7 of 10 so far).',
      null,
    ),
  },
  {
    dealId: DEAL_ID_2,
    brandName: 'Coil & Co',
    campaignName: 'Haircare — always-on',
    state: 'active' as const,
    total: usd('125000'),
    earned: usd('62500'),
    milestones: [
      milestone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        'Halfway',
        '62500',
        true,
        '5 videos approved.',
        '2026-09-12T09:15:00.000Z',
      ),
      milestone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
        'All 10 videos',
        '62500',
        false,
        '5 more videos need to be approved (5 of 10 so far).',
        null,
      ),
    ],
    deliverables: [
      {
        deliverableId: '88888888-8888-4888-8888-888888888874',
        slot: 'Video 5 of 10',
        state: 'in_review' as const,
        brief: 'Week 2 check-in.',
        latestVersion: 1,
        latestComment: null,
      },
    ],
    nextUnlock: milestone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      'All 10 videos',
      '62500',
      false,
      '5 more videos need to be approved (5 of 10 so far).',
      null,
    ),
  },
];

/** Three deliberately distinct figures. Never collapsed into one. */
const CREATOR_EARNINGS = {
  paidOut: usd('60000'),
  awaitingPayout: usd('62500'),
  agreedNotYetUnlocked: usd('242500'),
};

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

const MEMBERS = {
  members: [
    {
      memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      userId: 'usr_0001',
      email: 'founder@lumenskin.com',
      role: 'owner' as const,
      createdAt: '2026-06-02T10:00:00.000Z',
      hasMoneyAuthority: true,
    },
    {
      memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      userId: 'usr_0002',
      email: 'finance@lumenskin.com',
      role: 'admin' as const,
      createdAt: '2026-06-14T14:20:00.000Z',
      hasMoneyAuthority: true,
    },
    {
      // An admin WITHOUT money authority — the whole point of keeping the two
      // apart. Seniority in the org is not permission to move money.
      memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      userId: 'usr_0003',
      email: 'ops@lumenskin.com',
      role: 'admin' as const,
      createdAt: '2026-07-01T09:45:00.000Z',
      hasMoneyAuthority: false,
    },
    {
      // The agency operator. A real member row in the brand's org, and no
      // money authority the brand did not mint.
      memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      userId: 'usr_0004',
      email: 'rosa@northlightagency.com',
      role: 'member' as const,
      createdAt: '2026-08-11T16:05:00.000Z',
      hasMoneyAuthority: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

const SESSIONS = {
  sessions: [
    {
      sessionId: 'ses_current',
      createdAt: '2026-09-18T06:55:00.000Z',
      expiresAt: '2026-10-02T06:55:00.000Z',
      ipAddress: '203.0.113.10',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36',
      current: true,
    },
    {
      sessionId: 'ses_phone',
      createdAt: '2026-09-15T20:11:00.000Z',
      expiresAt: '2026-09-29T20:11:00.000Z',
      ipAddress: '198.51.100.24',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      current: false,
    },
    {
      sessionId: 'ses_unknown',
      createdAt: '2026-09-09T02:41:00.000Z',
      expiresAt: '2026-09-23T02:41:00.000Z',
      ipAddress: null,
      userAgent: null,
      current: false,
    },
  ],
};

const ACTIVITY = {
  // Real `AuditAction` values and their real copy. A fixture that invents an
  // action shows a screen the server can never produce.
  events: [
    {
      id: '1042',
      occurredAt: '2026-09-18T07:20:00.000Z',
      action: 'treasury.allocation_requested',
      label: 'Campaign budget was allocated',
      ipAddress: '203.0.113.10',
    },
    {
      id: '1041',
      occurredAt: '2026-09-18T06:58:00.000Z',
      action: 'account.step_up_granted',
      label: 'A security check was passed',
      ipAddress: '203.0.113.10',
    },
    {
      id: '1039',
      occurredAt: '2026-09-17T11:02:00.000Z',
      action: 'member.role_changed',
      label: "Someone's role was changed",
      ipAddress: '203.0.113.10',
    },
    {
      id: '1038',
      occurredAt: '2026-09-17T10:44:00.000Z',
      action: 'account.step_up_failed',
      label: 'A security code was entered incorrectly',
      ipAddress: '203.0.113.10',
    },
    {
      id: '1037',
      occurredAt: '2026-09-16T15:48:00.000Z',
      action: 'account.two_factor_enabled',
      label: 'An authenticator app was added',
      ipAddress: '198.51.100.24',
    },
    {
      id: '1031',
      occurredAt: '2026-09-15T20:11:00.000Z',
      action: 'session.revoked_all',
      label: 'All other devices were signed out',
      ipAddress: '198.51.100.24',
    },
  ],
};

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const BRANDS = {
  brands: [
    {
      organizationId: ORG_ID,
      name: 'Lumen Skincare',
      slug: 'lumen-skincare',
      createdAt: '2026-06-02T10:00:00.000Z',
      memberCount: 4,
      campaignCount: 3,
      activeDealCount: 18,
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111112',
      name: 'Coil & Co',
      slug: 'coil-and-co',
      createdAt: '2026-07-19T13:30:00.000Z',
      memberCount: 2,
      campaignCount: 1,
      activeDealCount: 6,
    },
    {
      organizationId: '11111111-1111-4111-8111-111111111113',
      name: 'Field Notes Coffee',
      slug: 'field-notes-coffee',
      createdAt: '2026-09-01T08:00:00.000Z',
      memberCount: 1,
      campaignCount: 0,
      activeDealCount: 0,
    },
  ],
};

const PLATFORM_STATS = {
  brandCount: 3,
  creatorCount: 214,
  activeDealCount: 24,
  releasedToCreators: usd('8412050'),
  fundsUnderManagement: usd('61475050'),
  // Deliberately a different order of magnitude from funds under management.
  // If these two ever look interchangeable on screen, the screen is wrong.
  platformRevenue: usd('252361'),
  pendingReviews: 27,
  computedAt: '2026-09-18T07:15:00.000Z',
};

const LEDGER_HEALTHY = {
  checkedAt: '2026-09-18T07:15:00.000Z',
  unbalancedEntries: [],
  driftedAccounts: [],
  auditChainBreaks: [],
  failedCommands: 0,
};

export const coreHandlers = [
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

  // -------------------------------------------------------------------------
  // Review
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId/review', async () => {
    await delay(200);
    if (scenario() === 'empty') {
      return HttpResponse.json({
        exceptions: [],
        cleared: { count: 0, submissionIds: [], releasesTotal: usd('0') },
      });
    }
    const exceptions = QUEUE_ROWS.filter((row) => !decided.has(row.submissionId));
    return HttpResponse.json({
      exceptions,
      cleared: {
        count: CLEARED_IDS.length,
        submissionIds: CLEARED_IDS,
        // Zero, always. A row that would release money is by definition not
        // cleared — it is an exception, and it is listed above.
        releasesTotal: usd('0'),
      },
    });
  }),

  http.post('*/api/v1/orgs/:orgId/submissions/:submissionId/approve', async ({ params }) => {
    await delay(260);
    const failure = PROBLEMS[scenario()];
    if (failure) {
      return HttpResponse.json(failure, {
        status: failure.status,
        headers: { 'content-type': 'application/problem+json' },
      });
    }

    const submissionId = String(params['submissionId']);
    const row = QUEUE_ROWS.find((candidate) => candidate.submissionId === submissionId);
    decided.add(submissionId);

    const reviewId = `cccccccc-cccc-4ccc-8ccc-${String(decided.size).padStart(12, '0')}`;
    reviewToSubmission.set(reviewId, submissionId);

    return HttpResponse.json({
      reviewId,
      deliverableId: row?.deliverableId ?? '88888888-8888-4888-8888-888888888800',
      satisfiedMilestoneIds: row?.releasesOnApproval ? ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'] : [],
      releases: row?.releasesOnApproval ?? usd('0'),
      // The server owns the window. The UI counts down to THIS instant and
      // never keeps its own copy of the duration.
      releasesAt: new Date(Date.now() + 30_000).toISOString(),
    });
  }),

  http.post('*/api/v1/orgs/:orgId/submissions/:submissionId/request-changes', async ({ params }) => {
    await delay(220);
    decided.add(String(params['submissionId']));
    return HttpResponse.json({ reviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccc99' });
  }),

  http.post('*/api/v1/orgs/:orgId/reviews/:reviewId/undo', async ({ params }) => {
    await delay(180);
    const submissionId = reviewToSubmission.get(String(params['reviewId']));
    if (submissionId) decided.delete(submissionId);
    return HttpResponse.json({ undone: true });
  }),

  // -------------------------------------------------------------------------
  // Creator
  // -------------------------------------------------------------------------

  http.get('*/api/v1/me/deals', async () => {
    await delay(200);
    return HttpResponse.json({ deals: scenario() === 'empty' ? [] : CREATOR_DEALS });
  }),

  http.get('*/api/v1/me/deals/:dealId', async ({ params }) => {
    await delay(180);
    const deal = CREATOR_DEALS.find((candidate) => candidate.dealId === String(params['dealId']));
    if (!deal) {
      const notFound = problem({
        title: 'Not found',
        status: 404,
        code: 'not_found',
        detail: 'No deal with that id, or it is not yours.',
      });
      return HttpResponse.json(notFound, {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(deal);
  }),

  http.post('*/api/v1/me/deliverables/:deliverableId/submit', async () => {
    await delay(500);
    return HttpResponse.json({ submissionId: '77777777-7777-4777-8777-7777777777ff', version: 2 }, {
      status: 201,
    });
  }),

  http.get('*/api/v1/me/earnings', async () => {
    await delay(160);
    return HttpResponse.json(
      scenario() === 'empty'
        ? { paidOut: usd('0'), awaitingPayout: usd('0'), agreedNotYetUnlocked: usd('0') }
        : CREATOR_EARNINGS,
    );
  }),

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId/members', async () => {
    await delay(190);
    return HttpResponse.json(scenario() === 'empty' ? { members: [] } : MEMBERS);
  }),

  http.post('*/api/v1/orgs/:orgId/members', async () => {
    await delay(320);
    return HttpResponse.json(
      { invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', status: 'pending' as const },
      { status: 201 },
    );
  }),

  http.patch('*/api/v1/orgs/:orgId/members/:memberId', async ({ params, request }) => {
    await delay(280);
    const body = (await request.json().catch(() => ({}))) as { role?: string };
    return HttpResponse.json({ memberId: String(params['memberId']), role: body.role ?? 'member' });
  }),

  http.post('*/api/v1/orgs/:orgId/members/:memberId/remove', async () => {
    await delay(280);
    return HttpResponse.json({ removed: true });
  }),

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  http.get('*/api/v1/me/sessions', async () => {
    await delay(150);
    return HttpResponse.json(SESSIONS);
  }),

  http.delete('*/api/v1/me/sessions/:sessionId', async () => {
    await delay(200);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post('*/api/v1/me/sessions/revoke-others', async () => {
    await delay(300);
    return HttpResponse.json({ revoked: 2 });
  }),

  http.get('*/api/v1/me/activity', async () => {
    await delay(170);
    return HttpResponse.json(ACTIVITY);
  }),

  http.post('*/api/v1/me/email', async () => {
    await delay(300);
    return HttpResponse.json({ status: 'pending_confirmation' as const }, { status: 202 });
  }),

  http.post('*/api/v1/me/two-factor/disable', async () => {
    await delay(300);
    return HttpResponse.json({ twoFactorEnabled: false });
  }),

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  http.get('*/api/v1/admin/brands', async () => {
    await delay(210);
    return HttpResponse.json(scenario() === 'empty' ? { brands: [] } : BRANDS);
  }),

  http.get('*/api/v1/admin/stats', async () => {
    await delay(230);
    if (scenario() === 'empty') {
      // No snapshot computed yet. The screen must say so rather than render
      // zeros, which are indistinguishable from a business that earned nothing.
      const none = problem({
        title: 'No snapshot yet',
        status: 404,
        code: 'not_found',
        detail: 'The worker has not computed a platform snapshot yet.',
      });
      return HttpResponse.json(none, {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(PLATFORM_STATS);
  }),

  http.get('*/api/v1/admin/ledger-health', async () => {
    await delay(190);
    if (scenario() === 'ledger-drift') {
      return HttpResponse.json({
        checkedAt: '2026-09-18T07:15:00.000Z',
        unbalancedEntries: ['entry_0f3a91'],
        driftedAccounts: ['ledger.account:campaign:22222222…:allocated'],
        auditChainBreaks: [{ seq: '10387', reason: 'hash does not match the previous row' }],
        failedCommands: 2,
      });
    }
    if (scenario() === 'empty') {
      // Never checked is NOT healthy, and must never render as a green tick.
      return HttpResponse.json({ ...LEDGER_HEALTHY, checkedAt: null });
    }
    return HttpResponse.json(LEDGER_HEALTHY);
  }),

];
