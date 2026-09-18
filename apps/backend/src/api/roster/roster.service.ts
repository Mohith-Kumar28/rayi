import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '@/database/prisma.service';

/**
 * The brand's creator roster.
 *
 * **A creator is a counterparty, not a member of the organization.** There is no
 * `Member` row for them, no role and no permissions — so this list is derived
 * from the DEALS rather than from a membership table. Modelling creators as
 * members would give them standing in an organization whose money they can see
 * part of.
 *
 * Everything is scoped to one organization. What a creator earns elsewhere, who
 * else they work with and how they perform on other campaigns are not a brand's
 * business, and their absence here is the design rather than an omission.
 */
@Injectable()
export class RosterService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, filters: { campaignId?: string; search?: string }) {
    const deals = await this.prisma.deal.findMany({
      where: {
        organizationId,
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
      },
      select: {
        creatorUserId: true,
        state: true,
        totalAmountMinor: true,
        currency: true,
        createdAt: true,
        creator: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            payoutDestination: { select: { payoutsEnabled: true, holdUntil: true } },
          },
        },
        deliverables: { select: { state: true } },
        agreements: {
          where: { supersededAt: null },
          select: { milestones: { select: { amountMinor: true, releasedAt: true } } },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const byCreator = new Map<string, ReturnType<typeof this.emptyAggregate>>();

    for (const deal of deals) {
      const key = deal.creatorUserId;
      const aggregate = byCreator.get(key) ?? this.emptyAggregate(deal);
      aggregate.dealCount += 1;
      if (['offered', 'accepted', 'active'].includes(deal.state)) {
        aggregate.activeDealCount += 1;
        aggregate.totalCommittedMinor += deal.totalAmountMinor;
      }
      aggregate.totalReleasedMinor += (deal.agreements[0]?.milestones ?? []).reduce(
        (sum, milestone) => (milestone.releasedAt ? sum + milestone.amountMinor : sum),
        0n,
      );
      aggregate.deliverablesApproved += deal.deliverables.filter(
        (row) => row.state === 'approved',
      ).length;
      aggregate.deliverablesDecided += deal.deliverables.filter((row) =>
        ['approved', 'changes_requested'].includes(row.state),
      ).length;
      if (!aggregate.firstDealAt || deal.createdAt < aggregate.firstDealAt) {
        aggregate.firstDealAt = deal.createdAt;
      }
      if (!aggregate.lastActivityAt || deal.createdAt > aggregate.lastActivityAt) {
        aggregate.lastActivityAt = deal.createdAt;
      }
      byCreator.set(key, aggregate);
    }

    const search = filters.search?.toLowerCase();
    const creators = [...byCreator.values()]
      .filter(
        (creator) =>
          !search ||
          creator.handle.toLowerCase().includes(search) ||
          (creator.displayName ?? '').toLowerCase().includes(search),
      )
      .map((creator) => ({
        ...creator,
        // Basis points, as an integer. A ratio displayed next to money never
        // goes through a float.
        approvalRateBps:
          creator.deliverablesDecided === 0
            ? null
            : Math.round((creator.deliverablesApproved * 10_000) / creator.deliverablesDecided),
      }))
      .sort((a, b) => (b.totalReleasedMinor > a.totalReleasedMinor ? 1 : -1));

    return {
      creators,
      currency: deals[0]?.currency ?? 'USD',
      releasedMinor: creators.reduce((sum, creator) => sum + creator.totalReleasedMinor, 0n),
    };
  }

  private emptyAggregate(deal: {
    creator: {
      id: string;
      username: string;
      firstName: string | null;
      lastName: string | null;
      payoutDestination: { payoutsEnabled: boolean; holdUntil: Date | null } | null;
    };
  }) {
    const name = [deal.creator.firstName, deal.creator.lastName].filter(Boolean).join(' ');
    return {
      creatorId: deal.creator.id,
      handle: `@${deal.creator.username}`,
      displayName: name.length > 0 ? name : null,
      // Absent destination means "not set up", never "enabled". Defaulting the
      // other way would tell a brand their creator can be paid when they cannot.
      payoutsEnabled: deal.creator.payoutDestination?.payoutsEnabled ?? false,
      payoutHoldUntil: deal.creator.payoutDestination?.holdUntil ?? null,
      dealCount: 0,
      activeDealCount: 0,
      totalReleasedMinor: 0n,
      totalCommittedMinor: 0n,
      deliverablesApproved: 0,
      deliverablesDecided: 0,
      firstDealAt: null as Date | null,
      lastActivityAt: null as Date | null,
    };
  }

  async get(organizationId: string, creatorId: string) {
    const summary = await this.list(organizationId, {});
    const creator = summary.creators.find((row) => row.creatorId === creatorId);
    if (!creator) throw new NotFoundException();

    const [profile, deals] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: creatorId }, select: { bio: true } }),
      this.prisma.deal.findMany({
        // Scoped to this organization, so a brand reading one creator cannot see
        // what that creator does for anyone else.
        where: { organizationId, creatorUserId: creatorId },
        select: {
          id: true,
          state: true,
          totalAmountMinor: true,
          currency: true,
          createdAt: true,
          campaign: { select: { name: true } },
          agreements: {
            where: { supersededAt: null },
            select: { milestones: { select: { amountMinor: true, releasedAt: true } } },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      ...creator,
      bio: profile?.bio ?? null,
      currency: summary.currency,
      deals: deals.map((deal) => ({
        dealId: deal.id,
        campaignName: deal.campaign.name,
        state: deal.state,
        totalMinor: deal.totalAmountMinor,
        releasedMinor: (deal.agreements[0]?.milestones ?? []).reduce(
          (sum, milestone) => (milestone.releasedAt ? sum + milestone.amountMinor : sum),
          0n,
        ),
        currency: deal.currency,
        createdAt: deal.createdAt,
      })),
    };
  }
}
