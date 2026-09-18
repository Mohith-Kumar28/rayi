import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * Campaigns.
 *
 * A campaign draws its budget from the ORGANIZATION balance; the workspace it
 * sits in decides whose approved ceiling that allocation is checked against.
 * Creating one moves no money, which is why nothing here takes an amount.
 *
 * **The allocated and released figures do not come from this process.** The api
 * role has no grants on the ledger schema at all, so reading a balance here
 * would fail in production while passing in development as a superuser — the
 * worst kind of difference, because it only appears once real money is behind
 * it. Money figures are derived from deal rows (what was committed) and from
 * the worker-fed funding surface (what actually moved).
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(organizationId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findFirst({
      // Both predicates. A miss is a 404: a 403 would confirm the campaign
      // exists, which is an enumeration oracle.
      where: { id: campaignId, organizationId },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        brief: true,
        state: true,
        currency: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        workspace: { select: { name: true } },
        deals: {
          select: {
            state: true,
            totalAmountMinor: true,
            deliverables: { select: { state: true } },
            agreements: {
              where: { supersededAt: null },
              select: { milestones: { select: { amountMinor: true, releasedAt: true } } },
              take: 1,
            },
          },
        },
      },
    });

    if (!campaign) throw new NotFoundException();

    // Committed counts the states where money is held and unpaid. A draft
    // promises nobody anything; a completed deal is already paid.
    const committedMinor = campaign.deals.reduce(
      (sum, deal) =>
        ['offered', 'accepted', 'active'].includes(deal.state) ? sum + deal.totalAmountMinor : sum,
      0n,
    );
    const releasedMinor = campaign.deals.reduce(
      (sum, deal) =>
        sum +
        (deal.agreements[0]?.milestones ?? []).reduce(
          (inner, milestone) => (milestone.releasedAt ? inner + milestone.amountMinor : inner),
          0n,
        ),
      0n,
    );

    const deliverables = campaign.deals.flatMap((deal) => deal.deliverables);

    return {
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      workspaceName: campaign.workspace.name,
      name: campaign.name,
      brief: campaign.brief,
      state: campaign.state,
      currency: campaign.currency,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
      createdAt: campaign.createdAt,
      committedMinor,
      releasedMinor,
      dealCount: campaign.deals.length,
      deliverablesTotal: deliverables.length,
      deliverablesApproved: deliverables.filter((row) => row.state === 'approved').length,
    };
  }

  async create(
    organizationId: string,
    input: {
      workspaceId: string;
      name: string;
      brief: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
    },
    actorUserId: string,
    context: RequestContext,
  ) {
    // The workspace must belong to this organization. The composite FK on
    // `campaign` enforces it as well; checking here turns a foreign-key error
    // into a 404 that says the right thing.
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: input.workspaceId, organizationId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException();

    const campaign = await this.prisma.campaign.create({
      data: {
        organizationId,
        workspaceId: input.workspaceId,
        name: input.name,
        brief: input.brief,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        state: 'draft',
      },
      select: { id: true },
    });

    await this.audit.record({
      action: AuditAction.CampaignCreated,
      organizationId,
      actorUserId,
      subjectType: 'campaign',
      subjectId: campaign.id,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { workspaceId: input.workspaceId, name: input.name },
    });

    return this.get(organizationId, campaign.id);
  }

  async update(
    organizationId: string,
    campaignId: string,
    input: {
      name?: string | undefined;
      brief?: string | null | undefined;
      endsAt?: Date | null | undefined;
      state?: string | undefined;
    },
    actorUserId: string,
    context: RequestContext,
  ) {
    const updated = await this.prisma.campaign.updateMany({
      where: { id: campaignId, organizationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
      },
    });
    if (updated.count === 0) throw new NotFoundException();

    await this.audit.record({
      action: AuditAction.CampaignUpdated,
      organizationId,
      actorUserId,
      subjectType: 'campaign',
      subjectId: campaignId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      // What changed, not the whole new row. A log of values is a log that
      // eventually contains something it should not.
      data: { changed: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined) },
    });

    return this.get(organizationId, campaignId);
  }
}
