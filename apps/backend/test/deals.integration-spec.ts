import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { DealsService } from '../src/api/deals/deals.service';
import { WorkspacesService } from '../src/api/workspaces/workspaces.service';
import { AuditService } from '../src/audit/audit.service';
import type { StepUpService } from '../src/auth/step-up/step-up.service';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * Deals, from the brand's side.
 *
 * Written as the ways money would go wrong:
 *
 *   1. A percentage re-evaluated later, silently rewriting an already-released
 *      milestone.
 *   2. An advance that hides from the disclosure by being typed as something
 *      else — `count: 0`, or a date already past.
 *   3. A client asserting an advance figure the server never derived, and the
 *      server paying the client's number.
 *   4. An offer that commits against a ceiling which cannot fund it.
 *   5. A termination that claws back money already released.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);

// Step-up has its own suite. Here it passes through, so these tests are about
// the money rules rather than about the second factor.
const stepUp = {
  mint: async () => undefined,
  consume: async () => undefined,
} as unknown as StepUpService;

const workspaces = new WorkspacesService(prismaService, stepUp, audit);
const deals = new DealsService(prismaService, stepUp, audit, workspaces);

async function seed(options: { ceilingMinor?: bigint } = {}) {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  const campaignId = randomUUID();
  const creatorId = randomUUID();
  const username = `creator_${creatorId.slice(0, 8)}`;

  await prisma.organization.create({
    data: { id: organizationId, name: 'Brand', slug: `b-${organizationId.slice(0, 8)}` },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, organizationId, name: 'Core', slug: 'core' },
  });
  await prisma.campaign.create({
    data: { id: campaignId, organizationId, workspaceId, name: 'Q4', state: 'live' },
  });
  await prisma.user.create({
    data: { id: creatorId, username, email: `${username}@example.com` },
  });
  if (options.ceilingMinor !== undefined) {
    await prisma.budgetEnvelope.create({
      data: {
        workspaceId,
        organizationId,
        ceilingMinor: options.ceilingMinor,
        updatedAt: new Date(),
      },
    });
  }

  return { organizationId, workspaceId, campaignId, creatorId, handle: `@${username}` };
}

function draft(campaignId: string, handle: string, milestones: unknown[] = []) {
  return {
    campaignId,
    creatorHandle: handle,
    totalMinor: 240_000n,
    currency: 'USD',
    deliverables: Array.from({ length: 20 }, () => ({ slot: 'v', brief: null, dueAt: null })),
    milestones: milestones as never[],
  };
}

describe('deals', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('preview', () => {
    it('resolves percentages to frozen minor units and distributes the odd cents', () => {
      const preview = deals.preview({
        campaignId: randomUUID(),
        creatorHandle: '@x',
        // 1000 minor units split three ways is 333.33…, so a remainder exists.
        totalMinor: 1_000n,
        currency: 'USD',
        deliverables: [{ slot: 'v', brief: null, dueAt: null }],
        milestones: [
          { title: 'a', percentageBps: 3_333, condition: { type: 'ALL_DELIVERABLES_APPROVED' } },
          { title: 'b', percentageBps: 3_333, condition: { type: 'ALL_DELIVERABLES_APPROVED' } },
          { title: 'c', percentageBps: 3_334, condition: { type: 'ALL_DELIVERABLES_APPROVED' } },
        ],
      });

      // Exact. An unallocated remainder is money nobody has decided about.
      expect(preview.milestoneTotalMinor).toBe(1_000n);
      expect(preview.balances).toBe(true);
    });

    /**
     * The disclosure is DERIVED, not declared.
     *
     * A brand cannot sidestep it by expressing an advance a different way, which
     * is the whole reason `isSatisfiableAtStart` evaluates the real condition
     * against an empty deal rather than checking for `type === 'ADVANCE'`.
     */
    it.each([
      ['a literal advance', { type: 'ADVANCE' }],
      ['a zero-count condition', { type: 'DELIVERABLES_APPROVED_COUNT', count: 0 }],
      ['a date already past', { type: 'DATE_REACHED', at: '2020-01-01T00:00:00.000Z' }],
    ])('catches %s as an advance', (_label, condition) => {
      const preview = deals.preview({
        campaignId: randomUUID(),
        creatorHandle: '@x',
        totalMinor: 100_000n,
        currency: 'USD',
        deliverables: [{ slot: 'v', brief: null, dueAt: null }],
        milestones: [
          { title: 'up front', percentageBps: 2_500, condition: condition as never },
          {
            title: 'rest',
            percentageBps: 7_500,
            condition: { type: 'ALL_DELIVERABLES_APPROVED' } as never,
          },
        ],
      });

      expect(preview.advanceTotalMinor).toBe(25_000n);
      expect(preview.milestones[0]?.satisfiableAtStart).toBe(true);
      expect(preview.milestones[1]?.satisfiableAtStart).toBe(false);
    });

    it('reports milestones that do not add up rather than silently adjusting them', () => {
      const preview = deals.preview({
        campaignId: randomUUID(),
        creatorHandle: '@x',
        totalMinor: 100_000n,
        currency: 'USD',
        deliverables: [{ slot: 'v', brief: null, dueAt: null }],
        milestones: [
          {
            title: 'only half',
            amountMinor: 50_000n,
            condition: { type: 'ALL_DELIVERABLES_APPROVED' } as never,
          },
        ],
      });

      expect(preview.problems.length).toBeGreaterThan(0);
      expect(preview.balances).toBe(false);
    });

    it('treats an empty schedule as one final milestone for the whole total', () => {
      const preview = deals.preview({
        campaignId: randomUUID(),
        creatorHandle: '@x',
        totalMinor: 100_000n,
        currency: 'USD',
        deliverables: [{ slot: 'v', brief: null, dueAt: null }],
        milestones: [],
      });

      expect(preview.milestones).toHaveLength(1);
      expect(preview.milestones[0]?.amountMinor).toBe(100_000n);
      expect(preview.advanceTotalMinor).toBe(0n);
    });
  });

  describe('offering', () => {
    it('freezes the resolved amounts on the row', async () => {
      const { organizationId, campaignId, handle } = await seed({ ceilingMinor: 1_000_000n });
      const deal = await deals.create(
        organizationId,
        draft(campaignId, handle, [
          { title: 'signing', percentageBps: 2_500, condition: { type: 'ADVANCE' } },
          {
            title: 'completion',
            percentageBps: 7_500,
            condition: { type: 'ALL_DELIVERABLES_APPROVED' },
          },
        ]),
        'actor-1',
        {},
      );

      expect(deal.milestones.map((m) => m.amountMinor)).toEqual([60_000n, 180_000n]);
      // The percentage survives for display only, and is never read at release.
      expect(deal.milestones[0]?.percentageBps).toBe(2_500);
    });

    /**
     * The client's figure is an ASSERTION, never an instruction.
     *
     * A stale authoring screen must not be able to consent on a brand's behalf
     * to money that leaves before work exists.
     */
    it('refuses an offer whose acknowledged advance disagrees with the server', async () => {
      const { organizationId, campaignId, handle } = await seed({ ceilingMinor: 1_000_000n });
      const deal = await deals.create(
        organizationId,
        draft(campaignId, handle, [
          { title: 'signing', percentageBps: 2_500, condition: { type: 'ADVANCE' } },
          {
            title: 'completion',
            percentageBps: 7_500,
            condition: { type: 'ALL_DELIVERABLES_APPROVED' },
          },
        ]),
        'actor-1',
        {},
      );

      await expect(
        deals.offer(
          organizationId,
          deal.dealId,
          // The real advance is 60_000.
          { acknowledgedAdvanceMinor: 0n, code: '000000' },
          'actor-1',
          {},
        ),
      ).rejects.toThrow(/releases 60000 minor units/);

      const after = await deals.get(organizationId, deal.dealId);
      // Nothing moved on a refusal.
      expect(after.state).toBe('draft');
    });

    it('refuses an offer the workspace ceiling cannot fund, and commits nothing', async () => {
      const { organizationId, workspaceId, campaignId, handle } = await seed({
        ceilingMinor: 100_000n,
      });
      const deal = await deals.create(organizationId, draft(campaignId, handle), 'actor-1', {});

      await expect(
        deals.offer(
          organizationId,
          deal.dealId,
          { acknowledgedAdvanceMinor: 0n },
          'actor-1',
          {},
        ),
        // Deliberately asserted, not swallowed.
      ).rejects.toThrow(/approved budget/i);

      const envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
      expect(envelope.committedMinor).toBe(0n);
      expect((await deals.get(organizationId, deal.dealId)).state).toBe('draft');
    });

    it('commits against the ceiling when it offers', async () => {
      const { organizationId, workspaceId, campaignId, handle } = await seed({
        ceilingMinor: 1_000_000n,
      });
      const deal = await deals.create(organizationId, draft(campaignId, handle), 'actor-1', {});

      const result = await deals.offer(
        organizationId,
        deal.dealId,
        { acknowledgedAdvanceMinor: 0n },
        'actor-1',
        {},
      );
      expect(result.state).toBe('offered');

      const envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
      expect(envelope.committedMinor).toBe(240_000n);
    });

    it('lets exactly one of two concurrent offers of the same deal through', async () => {
      const { organizationId, campaignId, handle } = await seed({ ceilingMinor: 10_000_000n });
      const deal = await deals.create(organizationId, draft(campaignId, handle), 'actor-1', {});

      const results = await Promise.allSettled([
        deals.offer(organizationId, deal.dealId, { acknowledgedAdvanceMinor: 0n }, 'a', {}),
        deals.offer(organizationId, deal.dealId, { acknowledgedAdvanceMinor: 0n }, 'a', {}),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
  });

  describe('terminating', () => {
    /**
     * Payout is final.
     *
     * Only the uncommitted remainder returns. A "returned" figure that included
     * released money would be a lie about where the money is.
     */
    it('returns only the unreleased remainder and leaves released money alone', async () => {
      const { organizationId, workspaceId, campaignId, handle } = await seed({
        ceilingMinor: 1_000_000n,
      });
      const deal = await deals.create(
        organizationId,
        draft(campaignId, handle, [
          { title: 'signing', percentageBps: 2_500, condition: { type: 'ADVANCE' } },
          {
            title: 'completion',
            percentageBps: 7_500,
            condition: { type: 'ALL_DELIVERABLES_APPROVED' },
          },
        ]),
        'actor-1',
        {},
      );
      await deals.offer(
        organizationId,
        deal.dealId,
        { acknowledgedAdvanceMinor: 60_000n, code: '000000' },
        'actor-1',
        {},
      );

      // The advance released.
      const milestone = deal.milestones[0]!;
      await prisma.milestone.update({
        where: { id: milestone.milestoneId },
        data: { releasedAt: new Date() },
      });

      const result = await deals.terminate(
        organizationId,
        deal.dealId,
        { reason: 'went quiet', code: '000000' },
        'actor-1',
        {},
      );

      expect(result.returnedMinor).toBe(180_000n);

      const envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
      // 240_000 committed, 180_000 returned — the released 60_000 stays held.
      expect(envelope.committedMinor).toBe(60_000n);

      const after = await deals.get(organizationId, deal.dealId);
      expect(after.state).toBe('terminated');
      expect(after.releasedMinor).toBe(60_000n);
    });

    it('refuses to terminate a deal that is not running', async () => {
      const { organizationId, campaignId, handle } = await seed({ ceilingMinor: 1_000_000n });
      const deal = await deals.create(organizationId, draft(campaignId, handle), 'actor-1', {});

      await expect(
        deals.terminate(organizationId, deal.dealId, { reason: 'x', code: '000000' }, 'a', {}),
      ).rejects.toThrow(/not running/i);
    });
  });

  describe('tenancy', () => {
    it('does not find a deal from another organization', async () => {
      const a = await seed({ ceilingMinor: 1_000_000n });
      const b = await seed({ ceilingMinor: 1_000_000n });
      const deal = await deals.create(a.organizationId, draft(a.campaignId, a.handle), 'x', {});

      // 404, not 403. A 403 would confirm the deal exists.
      await expect(deals.get(b.organizationId, deal.dealId)).rejects.toThrow(/not found/i);
    });
  });
});
