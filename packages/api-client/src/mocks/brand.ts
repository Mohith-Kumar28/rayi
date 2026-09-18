import { http, HttpResponse, delay } from 'msw';

import { CAMPAIGN_ID, DEAL_ID, DEAL_ID_2, ORG_ID, PROBLEMS, problem, scenario, usd } from './core.js';

/**
 * Brand-side fixtures: the organization, its workspaces, campaigns, deals and
 * creator roster.
 *
 * Amounts are chosen so the arithmetic on screen is checkable by eye and stays
 * consistent across surfaces — a campaign's allocated figure equals the sum of
 * its deals' totals, and the roster's released equals the deals' released. A
 * fixture set whose numbers do not reconcile makes every layout bug look like a
 * data bug, and hides the reverse.
 */

export const WORKSPACE_ID = '44444444-4444-4444-8444-444444444441';
const WORKSPACE_ID_2 = '44444444-4444-4444-8444-444444444442';
const CAMPAIGN_ID_2 = '22222222-2222-4222-8222-222222222223';
const CAMPAIGN_ID_3 = '22222222-2222-4222-8222-222222222224';

export const CREATOR_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const CREATOR_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
const CREATOR_ID_3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
const CREATOR_ID_4 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4';

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

const ORGANIZATION = {
  organizationId: ORG_ID,
  name: 'Lumen Skincare',
  slug: 'lumen-skincare',
  createdAt: '2026-06-02T10:00:00.000Z',
  frozen: false,
  // $10,000/day, the ceiling that applies when no genuine second approver
  // exists. A phished founder loses at most this before anything else catches it.
  dailyReleaseCeiling: usd('1000000'),
  // Today's release: @priyacuts' halfway milestone. It must never exceed the
  // total ever released, which the deal fixtures put at 2,175.00.
  dailyReleased: usd('62500'),
  bankAccountLast4: '6789',
  bankAccountStatus: 'verified' as const,
};

const INVITATIONS = {
  invitations: [
    {
      invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
      email: 'newcmo@lumenskin.com',
      role: 'admin' as const,
      status: 'pending' as const,
      invitedByEmail: 'founder@lumenskin.com',
      createdAt: '2026-09-16T09:12:00.000Z',
      expiresAt: '2026-09-23T09:12:00.000Z',
    },
    {
      // Expiring today. An unclaimed route into the organization is exactly the
      // thing that should be visible rather than sitting in someone's mailbox.
      invitationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
      email: 'contractor@northlightagency.com',
      role: 'member' as const,
      status: 'pending' as const,
      invitedByEmail: 'ops@lumenskin.com',
      createdAt: '2026-09-11T17:40:00.000Z',
      expiresAt: '2026-09-18T17:40:00.000Z',
    },
  ],
};

// ---------------------------------------------------------------------------
// Workspaces and budget envelopes
// ---------------------------------------------------------------------------

const WORKSPACES = [
  {
    workspaceId: WORKSPACE_ID,
    name: 'Core skincare',
    slug: 'core-skincare',
    createdAt: '2026-06-02T10:05:00.000Z',
    campaignCount: 2,
    memberCount: 3,
    envelope: {
      // Committed equals what this workspace's campaigns hold:
      // 7,500.00 (Skincare) + 4,225.50 (Haircare).
      ceiling: usd('1500000'),
      committed: usd('1172550'),
      remaining: usd('327450'),
      expiresAt: '2026-12-31T23:59:59.000Z',
      approvedByEmail: 'finance@lumenskin.com',
      approvedAt: '2026-08-01T11:00:00.000Z',
    },
  },
  {
    // Ceiling fully consumed. New allocations are refused and the deals already
    // running are untouched — the case the design is actually about.
    workspaceId: WORKSPACE_ID_2,
    name: 'UK market',
    slug: 'uk-market',
    createdAt: '2026-08-20T14:30:00.000Z',
    campaignCount: 1,
    memberCount: 2,
    envelope: {
      // Fully committed: the UK campaign below holds exactly the ceiling.
      ceiling: usd('200000'),
      committed: usd('200000'),
      remaining: usd('0'),
      expiresAt: '2026-10-31T23:59:59.000Z',
      approvedByEmail: 'finance@lumenskin.com',
      approvedAt: '2026-08-20T15:00:00.000Z',
    },
  },
  {
    // No envelope at all. Cannot allocate anything until finance approves one.
    workspaceId: '44444444-4444-4444-8444-444444444443',
    name: 'Experiments',
    slug: 'experiments',
    createdAt: '2026-09-14T08:00:00.000Z',
    campaignCount: 0,
    memberCount: 1,
    envelope: null,
  },
];

const WORKSPACE_MEMBERS = [
  {
    memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    email: 'founder@lumenskin.com',
    orgRole: 'owner' as const,
    isFinanceApprover: true,
    addedAt: '2026-06-02T10:05:00.000Z',
  },
  {
    memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    email: 'finance@lumenskin.com',
    orgRole: 'admin' as const,
    isFinanceApprover: true,
    addedAt: '2026-06-14T14:25:00.000Z',
  },
  {
    // In the workspace, not a finance approver. The reason workspaces are not
    // Better Auth teams: this distinction has nowhere to live in an org role.
    memberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
    email: 'rosa@northlightagency.com',
    orgRole: 'member' as const,
    isFinanceApprover: false,
    addedAt: '2026-08-11T16:10:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/*
 * Campaign figures, reconciled against the deals below.
 *
 * Every number here is derivable from DEAL_SUMMARIES: `committed` is the total
 * of deals in offered/accepted/active, `released` is the total actually
 * released, and the deliverable counts are the sums. That is not tidiness — a
 * fixture set whose numbers do not add up makes every layout bug look like a
 * data bug and hides the reverse, and it means nobody can check the screen by
 * eye.
 */
const CAMPAIGNS_DETAIL = [
  {
    campaignId: CAMPAIGN_ID,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Core skincare',
    name: 'Skincare — Q4 launch',
    brief: 'Barrier repair range. Vertical, 30–60s.',
    state: 'live' as const,
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-12-15T00:00:00.000Z',
    createdAt: '2026-08-18T10:00:00.000Z',
    allocated: usd('750000'),
    // @mayaonmain 2,400 (active) + @thekwongs 1,800 (offered). The draft
    // promises nobody anything and is not committed.
    committed: usd('420000'),
    released: usd('60000'),
    uncommitted: usd('330000'),
    dealCount: 3,
    deliverablesTotal: 50,
    deliverablesApproved: 7,
  },
  {
    campaignId: CAMPAIGN_ID_2,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Core skincare',
    name: 'Haircare — always-on',
    brief: 'Rolling always-on. Curl range.',
    state: 'live' as const,
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: null,
    createdAt: '2026-06-28T09:00:00.000Z',
    allocated: usd('422550'),
    // Only @priyacuts is live. The completed deal is paid and the terminated one
    // returned its remainder.
    committed: usd('125000'),
    released: usd('157500'),
    uncommitted: usd('297550'),
    dealCount: 3,
    deliverablesTotal: 26,
    deliverablesApproved: 20,
  },
  {
    campaignId: CAMPAIGN_ID_3,
    workspaceId: WORKSPACE_ID_2,
    workspaceName: 'UK market',
    name: 'UK market test',
    brief: null,
    state: 'draft' as const,
    startsAt: null,
    endsAt: null,
    createdAt: '2026-09-10T12:00:00.000Z',
    // Allocated but not yet spent — which is what exhausts the workspace's
    // ceiling while no deal has been offered from it.
    allocated: usd('200000'),
    committed: usd('0'),
    released: usd('0'),
    uncommitted: usd('200000'),
    dealCount: 0,
    // A draft campaign has no deliverables yet. It had 40 before, with no deals
    // to own them.
    deliverablesTotal: 0,
    deliverablesApproved: 0,
  },
];

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

const DEAL_SUMMARIES = [
  {
    dealId: DEAL_ID,
    campaignId: CAMPAIGN_ID,
    campaignName: 'Skincare — Q4 launch',
    creatorId: CREATOR_ID,
    creatorHandle: '@mayaonmain',
    state: 'active' as const,
    total: usd('240000'),
    released: usd('60000'),
    deliverablesTotal: 20,
    deliverablesApproved: 7,
    createdAt: '2026-08-28T10:00:00.000Z',
    acceptedAt: '2026-08-30T12:00:00.000Z',
  },
  {
    dealId: DEAL_ID_2,
    campaignId: CAMPAIGN_ID_2,
    campaignName: 'Haircare — always-on',
    creatorId: CREATOR_ID_2,
    creatorHandle: '@priyacuts',
    state: 'active' as const,
    total: usd('125000'),
    released: usd('62500'),
    deliverablesTotal: 12,
    deliverablesApproved: 11,
    createdAt: '2026-07-04T09:30:00.000Z',
    acceptedAt: '2026-07-05T08:15:00.000Z',
  },
  {
    // Offered and not yet accepted. An offer is not a deal, and the screen has
    // to be able to say so — money is committed, nothing is owed.
    dealId: '66666666-6666-4666-8666-666666666663',
    campaignId: CAMPAIGN_ID,
    campaignName: 'Skincare — Q4 launch',
    creatorId: CREATOR_ID_3,
    creatorHandle: '@thekwongs',
    state: 'offered' as const,
    total: usd('180000'),
    released: usd('0'),
    deliverablesTotal: 20,
    deliverablesApproved: 0,
    createdAt: '2026-09-16T14:20:00.000Z',
    acceptedAt: null,
  },
  {
    dealId: '66666666-6666-4666-8666-666666666664',
    campaignId: CAMPAIGN_ID,
    campaignName: 'Skincare — Q4 launch',
    creatorId: CREATOR_ID_4,
    creatorHandle: '@devonmakes',
    state: 'draft' as const,
    total: usd('95000'),
    released: usd('0'),
    deliverablesTotal: 10,
    deliverablesApproved: 0,
    createdAt: '2026-09-17T16:05:00.000Z',
    acceptedAt: null,
  },
  {
    dealId: '66666666-6666-4666-8666-666666666665',
    campaignId: CAMPAIGN_ID_2,
    campaignName: 'Haircare — always-on',
    creatorId: CREATOR_ID,
    creatorHandle: '@mayaonmain',
    state: 'completed' as const,
    total: usd('80000'),
    released: usd('80000'),
    deliverablesTotal: 8,
    deliverablesApproved: 8,
    createdAt: '2026-06-30T11:00:00.000Z',
    acceptedAt: '2026-07-01T10:00:00.000Z',
  },
  {
    // Terminated. Released stays released — payout is final — and the remainder
    // went back to the campaign allocation.
    dealId: '66666666-6666-4666-8666-666666666666',
    campaignId: CAMPAIGN_ID_2,
    campaignName: 'Haircare — always-on',
    creatorId: CREATOR_ID_3,
    creatorHandle: '@thekwongs',
    state: 'terminated' as const,
    total: usd('60000'),
    released: usd('15000'),
    deliverablesTotal: 6,
    deliverablesApproved: 1,
    createdAt: '2026-07-20T09:00:00.000Z',
    acceptedAt: '2026-07-21T09:00:00.000Z',
  },
];

const milestone = (
  id: string,
  title: string,
  amountMinor: string,
  bps: number | null,
  condition: Record<string, unknown>,
  satisfied: boolean,
  reason: string,
  releasedAt: string | null,
  satisfiableAtStart = false,
) => ({
  milestoneId: id,
  title,
  amount: usd(amountMinor),
  percentageBps: bps,
  condition,
  satisfied,
  reason,
  releasedAt,
  satisfiableAtStart,
});

const DEAL_DETAIL = {
  ...DEAL_SUMMARIES[0],
  milestones: [
    milestone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'On signing',
      '60000',
      2500,
      { type: 'ADVANCE' },
      true,
      'Paid when the deal was accepted.',
      '2026-08-30T12:04:00.000Z',
      // The disclosure is DERIVED, so an advance cannot be hidden by expressing
      // it as a zero-count or a past date instead.
      true,
    ),
    milestone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      'After 10 videos',
      '90000',
      3750,
      { type: 'DELIVERABLES_APPROVED_COUNT', count: 10 },
      false,
      '3 more videos need to be approved (7 of 10 so far).',
      null,
    ),
    milestone(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      'On completion',
      '90000',
      3750,
      { type: 'ALL_DELIVERABLES_APPROVED' },
      false,
      '13 more videos need to be approved (7 of 20 so far).',
      null,
    ),
  ],
  deliverables: Array.from({ length: 20 }, (_, i) => ({
    deliverableId: `88888888-8888-4888-8888-${String(i + 1).padStart(12, '0')}`,
    slot: `Video ${i + 1} of 20`,
    brief: i === 0 ? 'Barrier repair, 30–45s, show the texture.' : null,
    state: (i < 7 ? 'approved' : i === 7 ? 'in_review' : i === 8 ? 'changes_requested' : 'pending') as
      | 'pending'
      | 'submitted'
      | 'in_review'
      | 'changes_requested'
      | 'approved'
      | 'cancelled',
    latestVersion: i < 9 ? 1 : 0,
    dueAt: null,
  })),
  agreementVersions: [
    {
      version: 1,
      createdAt: '2026-08-28T10:00:00.000Z',
      acceptedAt: '2026-08-30T12:00:00.000Z',
      total: usd('240000'),
    },
  ],
};

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const ROSTER = [
  {
    creatorId: CREATOR_ID,
    handle: '@mayaonmain',
    displayName: 'Maya Oyelaran',
    bio: 'Skincare and everyday routines. Lagos → London.',
    payoutsEnabled: true,
    payoutHoldUntil: null,
    dealCount: 2,
    activeDealCount: 1,
    totalReleased: usd('140000'),
    totalCommitted: usd('180000'),
    deliverablesApproved: 15,
    approvalRateBps: 9375,
    firstDealAt: '2026-06-30T11:00:00.000Z',
    lastActivityAt: '2026-09-18T07:12:00.000Z',
  },
  {
    creatorId: CREATOR_ID_2,
    handle: '@priyacuts',
    displayName: 'Priya Raghunathan',
    bio: 'Curly hair, honest reviews, no filters.',
    payoutsEnabled: true,
    // On a 72-hour hold after changing their payout destination. The brand sees
    // WHY their creator has not been paid, rather than assuming Rayi is broken.
    payoutHoldUntil: '2026-09-20T14:00:00.000Z',
    dealCount: 1,
    activeDealCount: 1,
    totalReleased: usd('62500'),
    totalCommitted: usd('62500'),
    deliverablesApproved: 11,
    approvalRateBps: 9167,
    firstDealAt: '2026-07-04T09:30:00.000Z',
    lastActivityAt: '2026-09-17T18:02:00.000Z',
  },
  {
    creatorId: CREATOR_ID_3,
    handle: '@thekwongs',
    displayName: null,
    bio: null,
    // Cannot be paid at all. Work can still be accepted and done; the money
    // waits rather than failing, and this is what tells a brand why.
    payoutsEnabled: false,
    payoutHoldUntil: null,
    dealCount: 2,
    activeDealCount: 1,
    totalReleased: usd('15000'),
    totalCommitted: usd('180000'),
    deliverablesApproved: 1,
    approvalRateBps: 5000,
    firstDealAt: '2026-07-20T09:00:00.000Z',
    lastActivityAt: '2026-09-18T06:40:00.000Z',
  },
  {
    creatorId: CREATOR_ID_4,
    handle: '@devonmakes',
    displayName: 'Devon Achebe',
    bio: 'Grooming and barbering. Chicago.',
    payoutsEnabled: true,
    payoutHoldUntil: null,
    dealCount: 1,
    activeDealCount: 0,
    totalReleased: usd('0'),
    totalCommitted: usd('0'),
    deliverablesApproved: 0,
    approvalRateBps: null,
    firstDealAt: null,
    lastActivityAt: '2026-09-17T15:30:00.000Z',
  },
];

const empty = () => scenario() === 'empty';

export const brandHandlers = [
  // -------------------------------------------------------------------------
  // Organization
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId', async () => {
    await delay(150);
    return HttpResponse.json(ORGANIZATION);
  }),

  http.patch('*/api/v1/orgs/:orgId', async ({ request }) => {
    await delay(320);
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    return HttpResponse.json({ ...ORGANIZATION, name: body.name ?? ORGANIZATION.name });
  }),

  http.get('*/api/v1/orgs/:orgId/invitations', async () => {
    await delay(170);
    return HttpResponse.json(empty() ? { invitations: [] } : INVITATIONS);
  }),

  http.post('*/api/v1/orgs/:orgId/invitations/:invitationId/revoke', async () => {
    await delay(260);
    return HttpResponse.json({ revoked: true });
  }),

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId/workspaces', async () => {
    await delay(190);
    return HttpResponse.json({ workspaces: empty() ? [] : WORKSPACES });
  }),

  http.post('*/api/v1/orgs/:orgId/workspaces', async ({ request }) => {
    await delay(340);
    const body = (await request.json().catch(() => ({}))) as { name?: string; slug?: string };
    return HttpResponse.json(
      {
        workspaceId: '44444444-4444-4444-8444-4444444444ff',
        name: body.name ?? 'New workspace',
        slug: body.slug ?? 'new-workspace',
        createdAt: new Date().toISOString(),
        campaignCount: 0,
        memberCount: 1,
        envelope: null,
      },
      { status: 201 },
    );
  }),

  http.get('*/api/v1/orgs/:orgId/workspaces/:workspaceId', async ({ params }) => {
    await delay(200);
    const workspace =
      WORKSPACES.find((row) => row.workspaceId === String(params['workspaceId'])) ?? WORKSPACES[0]!;
    return HttpResponse.json({
      ...workspace,
      members: WORKSPACE_MEMBERS.slice(0, workspace.memberCount),
      campaigns: CAMPAIGNS_DETAIL.filter(
        (campaign) => campaign.workspaceId === workspace.workspaceId,
      ).map((campaign) => ({
        campaignId: campaign.campaignId,
        name: campaign.name,
        state: campaign.state,
        allocated: campaign.allocated,
      })),
    });
  }),

  http.patch('*/api/v1/orgs/:orgId/workspaces/:workspaceId', async ({ request }) => {
    await delay(280);
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    return HttpResponse.json({ ...WORKSPACES[0], name: body.name ?? WORKSPACES[0]!.name });
  }),

  http.put('*/api/v1/orgs/:orgId/workspaces/:workspaceId/envelope', async ({ request }) => {
    await delay(420);
    const failure = PROBLEMS[scenario()];
    if (failure) {
      return HttpResponse.json(failure, {
        status: failure.status,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    const body = (await request.json().catch(() => ({}))) as {
      ceiling?: { amountMinor: string };
      expiresAt?: string | null;
    };
    const ceilingMinor = BigInt(body.ceiling?.amountMinor ?? '0');
    const committedMinor = BigInt(WORKSPACES[0]!.envelope!.committed.amountMinor);
    return HttpResponse.json({
      ceiling: usd(String(ceilingMinor)),
      committed: usd(String(committedMinor)),
      // Never negative. A ceiling below what is committed does not claw anything
      // back — the server refuses it — so remaining floors at zero here too.
      remaining: usd(String(ceilingMinor > committedMinor ? ceilingMinor - committedMinor : 0n)),
      expiresAt: body.expiresAt ?? null,
      approvedByEmail: 'finance@lumenskin.com',
      approvedAt: new Date().toISOString(),
    });
  }),

  http.post('*/api/v1/orgs/:orgId/workspaces/:workspaceId/members', async ({ request }) => {
    await delay(280);
    const body = (await request.json().catch(() => ({}))) as {
      memberId?: string;
      isFinanceApprover?: boolean;
    };
    return HttpResponse.json(
      {
        memberId: body.memberId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
        email: 'ops@lumenskin.com',
        orgRole: 'admin' as const,
        isFinanceApprover: body.isFinanceApprover ?? false,
        addedAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  }),

  http.delete('*/api/v1/orgs/:orgId/workspaces/:workspaceId/members/:memberId', async () => {
    await delay(240);
    return HttpResponse.json({ removed: true });
  }),

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------

  http.post('*/api/v1/orgs/:orgId/campaigns', async ({ request }) => {
    await delay(360);
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      workspaceId?: string;
      brief?: string | null;
    };
    return HttpResponse.json(
      {
        ...CAMPAIGNS_DETAIL[2],
        campaignId: '22222222-2222-4222-8222-2222222222ff',
        workspaceId: body.workspaceId ?? WORKSPACE_ID,
        name: body.name ?? 'New campaign',
        brief: body.brief ?? null,
        createdAt: new Date().toISOString(),
        deliverablesTotal: 0,
      },
      { status: 201 },
    );
  }),

  http.get('*/api/v1/orgs/:orgId/campaigns/:campaignId', async ({ params }) => {
    await delay(200);
    const found = CAMPAIGNS_DETAIL.find((row) => row.campaignId === String(params['campaignId']));
    if (!found) {
      const notFound = problem({ title: 'Not found', status: 404, code: 'not_found' });
      return HttpResponse.json(notFound, {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(found);
  }),

  http.patch('*/api/v1/orgs/:orgId/campaigns/:campaignId', async ({ params, request }) => {
    await delay(300);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const found =
      CAMPAIGNS_DETAIL.find((row) => row.campaignId === String(params['campaignId'])) ??
      CAMPAIGNS_DETAIL[0];
    return HttpResponse.json({ ...found, ...body });
  }),

  // -------------------------------------------------------------------------
  // Deals
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId/deals', async ({ request }) => {
    await delay(220);
    if (empty()) {
      return HttpResponse.json({
        deals: [],
        totals: { committed: usd('0'), released: usd('0') },
      });
    }
    const url = new URL(request.url);
    const campaignId = url.searchParams.get('campaignId');
    const state = url.searchParams.get('state');
    const creatorId = url.searchParams.get('creatorId');

    const deals = DEAL_SUMMARIES.filter(
      (deal) =>
        (!campaignId || deal.campaignId === campaignId) &&
        (!state || deal.state === state) &&
        (!creatorId || deal.creatorId === creatorId),
    );

    // Totals are computed over the FILTERED set, on the server. The browser
    // never adds money up: a client that does can disagree with the ledger.
    //
    // `committed` counts only the states where money is actually held and
    // unpaid. A draft promises nobody anything, a completed deal is already
    // paid, and a terminated one returned its remainder — including them would
    // overstate what the brand still owes by everything they ever finished.
    const COMMITTED_STATES = new Set(['offered', 'accepted', 'active']);
    const committed = deals.reduce(
      (sum, deal) => (COMMITTED_STATES.has(deal.state) ? sum + BigInt(deal.total.amountMinor) : sum),
      0n,
    );
    const released = deals.reduce((sum, deal) => sum + BigInt(deal.released.amountMinor), 0n);

    return HttpResponse.json({
      deals,
      totals: { committed: usd(String(committed)), released: usd(String(released)) },
    });
  }),

  http.get('*/api/v1/orgs/:orgId/deals/:dealId', async ({ params }) => {
    await delay(200);
    const summary = DEAL_SUMMARIES.find((row) => row.dealId === String(params['dealId']));
    if (!summary) {
      const notFound = problem({ title: 'Not found', status: 404, code: 'not_found' });
      return HttpResponse.json(notFound, {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json({ ...DEAL_DETAIL, ...summary });
  }),

  /**
   * The preview. Resolves percentages, distributes the odd cents by largest
   * remainder, and derives the advance disclosure — the same arithmetic the
   * real acceptance path freezes, so the figure a brand consents to is the
   * figure that gets stored.
   */
  http.post('*/api/v1/orgs/:orgId/deals/preview', async ({ request }) => {
    await delay(260);
    const body = (await request.json().catch(() => ({}))) as {
      total?: { amountMinor?: string };
      milestones?: Array<{
        title?: string;
        amount?: { amountMinor?: string };
        percentageBps?: number;
        condition?: { type?: string; count?: number; at?: string };
      }>;
      deliverables?: unknown[];
    };

    const totalMinor = BigInt(body.total?.amountMinor ?? '0');
    const inputs = body.milestones ?? [];

    // Largest remainder: every share floors, then the leftover cents go to the
    // EARLIEST milestones one at a time. The sum is exact by construction.
    const shares = inputs.map((input) =>
      input.percentageBps != null
        ? (totalMinor * BigInt(input.percentageBps)) / 10_000n
        : BigInt(input.amount?.amountMinor ?? '0'),
    );
    const allocated = shares.reduce((sum, share) => sum + share, 0n);
    const anyPercentage = inputs.some((input) => input.percentageBps != null);
    let leftover = anyPercentage ? totalMinor - allocated : 0n;
    const resolved = shares.map((share, index) => {
      if (leftover > 0n && inputs[index]?.percentageBps != null) {
        leftover -= 1n;
        return share + 1n;
      }
      return share;
    });

    const milestones = inputs.map((input, index) => {
      const condition = input.condition ?? { type: 'ALL_DELIVERABLES_APPROVED' };
      // DERIVED, not declared. `count: 0` and a past date are advances too, so a
      // brand cannot sidestep the disclosure by expressing one a different way.
      const satisfiableAtStart =
        condition.type === 'ADVANCE' ||
        (condition.type === 'DELIVERABLES_APPROVED_COUNT' && (condition.count ?? 0) === 0) ||
        (condition.type === 'DATE_REACHED' &&
          condition.at != null &&
          new Date(condition.at).getTime() <= Date.now());

      return {
        title: input.title ?? 'Milestone',
        amount: usd(String(resolved[index] ?? 0n)),
        percentageBps: input.percentageBps ?? null,
        condition,
        satisfiableAtStart,
        reason: satisfiableAtStart
          ? 'Releases as soon as the creator accepts — before any work exists.'
          : condition.type === 'DELIVERABLES_APPROVED_COUNT'
            ? `Releases once ${condition.count} deliverables are approved.`
            : condition.type === 'ALL_DELIVERABLES_APPROVED'
              ? 'Releases once every deliverable is approved.'
              : condition.type === 'MANUAL_BRAND_APPROVAL'
                ? 'Releases when you approve it yourself.'
                : condition.type === 'DATE_REACHED'
                  ? 'Releases on the date given.'
                  : 'Releases when the listed deliverables are approved.',
      };
    });

    const milestoneTotal = resolved.reduce((sum, amount) => sum + amount, 0n);
    const advanceTotal = milestones.reduce(
      (sum, item) => (item.satisfiableAtStart ? sum + BigInt(item.amount.amountMinor) : sum),
      0n,
    );

    const problems: string[] = [];
    if (totalMinor <= 0n) problems.push('The deal total must be more than zero.');
    if ((body.deliverables?.length ?? 0) === 0)
      problems.push('A deal needs at least one deliverable.');
    if (inputs.length > 0 && milestoneTotal !== totalMinor) {
      problems.push('The milestones do not add up to the deal total.');
    }

    return HttpResponse.json({
      milestones,
      milestoneTotal: usd(String(milestoneTotal)),
      total: usd(String(totalMinor)),
      balances: inputs.length === 0 || milestoneTotal === totalMinor,
      advanceTotal: usd(String(advanceTotal)),
      problems,
    });
  }),

  http.post('*/api/v1/orgs/:orgId/deals', async () => {
    await delay(420);
    return HttpResponse.json(
      { ...DEAL_DETAIL, dealId: '66666666-6666-4666-8666-6666666666ff', state: 'draft' },
      { status: 201 },
    );
  }),

  http.post('*/api/v1/orgs/:orgId/deals/:dealId/offer', async ({ params }) => {
    await delay(500);
    const failure = PROBLEMS[scenario()];
    if (failure) {
      return HttpResponse.json(failure, {
        status: failure.status,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return HttpResponse.json(
      {
        dealId: String(params['dealId']),
        state: 'offered' as const,
        offeredAt: new Date().toISOString(),
      },
      { status: 202 },
    );
  }),

  http.post('*/api/v1/orgs/:orgId/deals/:dealId/terminate', async ({ params }) => {
    await delay(420);
    return HttpResponse.json(
      {
        dealId: String(params['dealId']),
        state: 'terminated' as const,
        // What comes BACK to the campaign. Released money is not in this figure:
        // payout is final and nothing claws it back.
        returned: usd('180000'),
      },
      { status: 202 },
    );
  }),

  // -------------------------------------------------------------------------
  // Roster
  // -------------------------------------------------------------------------

  http.get('*/api/v1/orgs/:orgId/creators', async ({ request }) => {
    await delay(210);
    if (empty()) {
      return HttpResponse.json({
        creators: [],
        totals: { creatorCount: 0, released: usd('0') },
      });
    }
    const search = new URL(request.url).searchParams.get('search')?.toLowerCase();
    const creators = search
      ? ROSTER.filter(
          (creator) =>
            creator.handle.toLowerCase().includes(search) ||
            (creator.displayName ?? '').toLowerCase().includes(search),
        )
      : ROSTER;
    const released = creators.reduce(
      (sum, creator) => sum + BigInt(creator.totalReleased.amountMinor),
      0n,
    );
    return HttpResponse.json({
      creators,
      totals: { creatorCount: creators.length, released: usd(String(released)) },
    });
  }),

  http.get('*/api/v1/orgs/:orgId/creators/:creatorId', async ({ params }) => {
    await delay(190);
    const creator =
      ROSTER.find((row) => row.creatorId === String(params['creatorId'])) ?? ROSTER[0]!;
    return HttpResponse.json({
      ...creator,
      // Their own bio. A hardcoded one here showed @mayaonmain's text on every
      // creator, which looks exactly like a data-leak bug.
      bio: creator.bio,
      deals: DEAL_SUMMARIES.filter((deal) => deal.creatorId === creator.creatorId).map((deal) => ({
        dealId: deal.dealId,
        campaignName: deal.campaignName,
        state: deal.state,
        total: deal.total,
        released: deal.released,
        createdAt: deal.createdAt,
      })),
    });
  }),
];
