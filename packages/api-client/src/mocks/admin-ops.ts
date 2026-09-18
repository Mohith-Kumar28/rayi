import { http, HttpResponse, delay } from 'msw';

import { ORG_ID, scenario, usd } from './core.js';

/**
 * The operational admin surfaces.
 *
 * Deliberately NOT all-green. A dashboard whose fixtures are always healthy is
 * a dashboard nobody has seen work: the failed command, the unprocessed webhook
 * and the signature failure below are the states the screens exist for, and if
 * they are never rendered nobody knows whether they render.
 */

const BRAND_DETAIL = {
  organizationId: ORG_ID,
  name: 'Lumen Skincare',
  slug: 'lumen-skincare',
  createdAt: '2026-06-02T10:00:00.000Z',
  memberCount: 4,
  campaignCount: 3,
  activeDealCount: 18,
  frozen: false,
  bankAccountStatus: 'verified' as const,
  funded: usd('61475050'),
  allocated: usd('11725050'),
  released: usd('7282050'),
  computedAt: '2026-09-18T07:15:00.000Z',
  workspaces: [
    { workspaceId: '44444444-4444-4444-8444-444444444441', name: 'Core skincare', campaignCount: 2 },
    { workspaceId: '44444444-4444-4444-8444-444444444442', name: 'UK market', campaignCount: 1 },
    { workspaceId: '44444444-4444-4444-8444-444444444443', name: 'Experiments', campaignCount: 0 },
  ],
  owners: [
    { email: 'founder@lumenskin.com', role: 'owner' },
    { email: 'finance@lumenskin.com', role: 'admin' },
  ],
};

const PLATFORM_CREATORS = [
  {
    creatorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    handle: '@mayaonmain',
    email: 'maya@example.com',
    payoutsEnabled: true,
    payoutHoldUntil: null,
    brandCount: 2,
    activeDealCount: 1,
    totalReleased: usd('140000'),
    joinedAt: '2026-06-28T14:00:00.000Z',
  },
  {
    creatorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    handle: '@priyacuts',
    email: 'priya@example.com',
    payoutsEnabled: true,
    payoutHoldUntil: '2026-09-20T14:00:00.000Z',
    brandCount: 1,
    activeDealCount: 1,
    totalReleased: usd('62500'),
    joinedAt: '2026-07-02T10:30:00.000Z',
  },
  {
    // Has money owed and cannot receive it. The actionable row on this screen.
    creatorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3',
    handle: '@thekwongs',
    email: 'kwong@example.com',
    payoutsEnabled: false,
    payoutHoldUntil: null,
    brandCount: 1,
    activeDealCount: 1,
    totalReleased: usd('15000'),
    joinedAt: '2026-07-18T08:00:00.000Z',
  },
  {
    creatorId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
    handle: '@devonmakes',
    email: 'devon@example.com',
    payoutsEnabled: true,
    payoutHoldUntil: null,
    brandCount: 1,
    activeDealCount: 0,
    totalReleased: usd('0'),
    joinedAt: '2026-09-14T19:20:00.000Z',
  },
];

const TREASURY_COMMANDS = [
  {
    commandId: '55555555-5555-4555-8555-555555555501',
    kind: 'release_milestone',
    state: 'failed' as const,
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    attempts: 5,
    claimedBy: null,
    claimedAt: null,
    createdAt: '2026-09-18T06:02:00.000Z',
    lastError:
      'Stripe returned balance_insufficient: the platform available balance does not yet cover ' +
      'this transfer. The source charge settles on 19 Sep.',
    expectedAvailable: usd('180000'),
  },
  {
    // Claimed hours ago and never finished: a worker died holding the lease.
    commandId: '55555555-5555-4555-8555-555555555502',
    kind: 'allocate_budget',
    state: 'claimed' as const,
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    attempts: 1,
    claimedBy: 'worker-7f3a',
    claimedAt: '2026-09-18T03:11:00.000Z',
    createdAt: '2026-09-18T03:10:00.000Z',
    lastError: null,
    expectedAvailable: usd('41250000'),
  },
  {
    commandId: '55555555-5555-4555-8555-555555555503',
    kind: 'allocate_budget',
    state: 'succeeded' as const,
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    attempts: 1,
    claimedBy: 'worker-91cc',
    claimedAt: '2026-09-18T07:20:04.000Z',
    createdAt: '2026-09-18T07:20:00.000Z',
    lastError: null,
    expectedAvailable: usd('41250000'),
  },
  {
    commandId: '55555555-5555-4555-8555-555555555504',
    kind: 'release_milestone',
    state: 'pending' as const,
    organizationId: '11111111-1111-4111-8111-111111111112',
    organizationName: 'Coil & Co',
    attempts: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: '2026-09-18T07:31:00.000Z',
    lastError: null,
    expectedAvailable: usd('62500'),
  },
];

const WEBHOOKS = [
  {
    deliveryId: '77777777-7777-4777-8777-777777777f01',
    source: 'stripe_connect' as const,
    eventType: 'account.updated',
    state: 'processed' as const,
    receivedAt: '2026-09-18T07:22:00.000Z',
    processedAt: '2026-09-18T07:22:01.000Z',
    lastError: null,
  },
  {
    // Verified, stored, never interpreted. A three-day fuse with nothing else
    // announcing it.
    deliveryId: '77777777-7777-4777-8777-777777777f02',
    source: 'stripe_platform' as const,
    eventType: 'charge.dispute.created',
    state: 'received' as const,
    receivedAt: '2026-09-18T05:40:00.000Z',
    processedAt: null,
    lastError: null,
  },
  {
    /*
     * A delivery that was accepted and then failed to PROCESS — not a signature
     * failure. Those are refused at the edge and never become rows.
     */
    deliveryId: '77777777-7777-4777-8777-777777777f03',
    source: 'stripe_platform' as const,
    eventType: 'payout.failed',
    state: 'failed' as const,
    receivedAt: '2026-09-18T04:12:00.000Z',
    processedAt: null,
    lastError: 'No connected account matches the destination on this payout.',
  },
  {
    deliveryId: '77777777-7777-4777-8777-777777777f04',
    source: 'resend' as const,
    eventType: 'email.bounced',
    state: 'processed' as const,
    receivedAt: '2026-09-17T19:55:00.000Z',
    processedAt: '2026-09-17T19:55:00.000Z',
    lastError: null,
  },
];

const AUDIT = [
  {
    seq: '10412',
    occurredAt: '2026-09-18T07:20:00.000Z',
    action: 'treasury.allocation_requested',
    label: 'Campaign budget was allocated',
    actorEmail: 'founder@lumenskin.com',
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    ipAddress: '203.0.113.10',
    chainValid: true,
  },
  {
    seq: '10411',
    occurredAt: '2026-09-18T07:02:00.000Z',
    action: 'money_authority.denied',
    label: 'An attempt to move money was refused',
    actorEmail: 'ops@lumenskin.com',
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    ipAddress: '203.0.113.44',
    chainValid: true,
  },
  {
    seq: '10409',
    occurredAt: '2026-09-17T11:02:00.000Z',
    action: 'member.role_changed',
    label: "Someone's role was changed",
    actorEmail: 'founder@lumenskin.com',
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    ipAddress: '203.0.113.10',
    chainValid: true,
  },
  {
    seq: '10402',
    occurredAt: '2026-09-16T22:41:00.000Z',
    action: 'money_authority.granted',
    label: 'Permission to move money was granted',
    actorEmail: 'founder@lumenskin.com',
    organizationId: ORG_ID,
    organizationName: 'Lumen Skincare',
    ipAddress: '203.0.113.10',
    chainValid: true,
  },
];

const MONEY_ACTIONS = new Set([
  'treasury.allocation_requested',
  'treasury.allocation_posted',
  'treasury.allocation_failed',
  'money_authority.granted',
  'money_authority.revoked',
  'money_authority.denied',
  'deliverable.approved',
  'milestone.satisfied',
]);

export const adminOpsHandlers = [
  http.get('*/api/v1/admin/brands/:brandId', async () => {
    await delay(210);
    return HttpResponse.json(BRAND_DETAIL);
  }),

  http.get('*/api/v1/admin/creators', async ({ request }) => {
    await delay(220);
    if (scenario() === 'empty') {
      return HttpResponse.json({ creators: [], blockedCount: 0 });
    }
    const url = new URL(request.url);
    const search = url.searchParams.get('search')?.toLowerCase();
    const blockedOnly = url.searchParams.get('blockedOnly') === 'true';

    const creators = PLATFORM_CREATORS.filter(
      (creator) =>
        (!search || creator.handle.toLowerCase().includes(search)) &&
        (!blockedOnly || !creator.payoutsEnabled || creator.payoutHoldUntil !== null),
    );
    // Blocked means "owed money and cannot receive it", so a creator with
    // nothing owed is not counted — they are not a person waiting.
    const blockedCount = PLATFORM_CREATORS.filter(
      (creator) =>
        (!creator.payoutsEnabled || creator.payoutHoldUntil !== null) &&
        BigInt(creator.totalReleased.amountMinor) > 0n,
    ).length;

    return HttpResponse.json({ creators, blockedCount });
  }),

  http.get('*/api/v1/admin/treasury-commands', async ({ request }) => {
    await delay(200);
    const state = new URL(request.url).searchParams.get('state');
    const commands = state
      ? TREASURY_COMMANDS.filter((command) => command.state === state)
      : TREASURY_COMMANDS;
    return HttpResponse.json({
      commands,
      failedCount: TREASURY_COMMANDS.filter((command) => command.state === 'failed').length,
      stuckCount: TREASURY_COMMANDS.filter(
        (command) =>
          command.state === 'claimed' &&
          command.claimedAt !== null &&
          Date.now() - new Date(command.claimedAt).getTime() > 15 * 60_000,
      ).length,
    });
  }),

  http.get('*/api/v1/admin/webhooks', async ({ request }) => {
    await delay(190);
    const url = new URL(request.url);
    const source = url.searchParams.get('source');
    const failedOnly = url.searchParams.get('failedOnly') === 'true';
    const deliveries = WEBHOOKS.filter(
      (delivery) =>
        (!source || delivery.source === source) && (!failedOnly || delivery.state === 'failed'),
    );
    return HttpResponse.json({
      deliveries,
      failedCount: WEBHOOKS.filter((delivery) => delivery.state === 'failed').length,
      unprocessedCount: WEBHOOKS.filter((delivery) => delivery.state === 'received').length,
    });
  }),

  http.get('*/api/v1/admin/audit', async ({ request }) => {
    await delay(230);
    const url = new URL(request.url);
    const action = url.searchParams.get('action');
    const moneyOnly = url.searchParams.get('moneyOnly') === 'true';
    const drift = scenario() === 'ledger-drift';

    const events = AUDIT.filter(
      (event) =>
        (!action || event.action.includes(action)) &&
        (!moneyOnly || MONEY_ACTIONS.has(event.action)),
    ).map((event) =>
      // Under drift, one row's hash no longer matches — located, not merely counted.
      drift && event.seq === '10409' ? { ...event, chainValid: false } : event,
    );

    return HttpResponse.json({
      events,
      chainBreakCount: events.filter((event) => !event.chainValid).length,
    });
  }),
];
