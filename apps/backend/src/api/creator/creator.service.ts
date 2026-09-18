import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { evaluateDeal, type DealFacts, type MilestoneCondition } from '@rayi/domain';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * What a creator can see and do.
 *
 * **Every query is scoped by the session's user id in the WHERE clause.** There
 * is no creator id parameter anywhere in this service, and there must never be
 * one: a creator is not a tenant member, so there is no org predicate to fall
 * back on, and the session is the only thing that says who they are.
 *
 * The population this serves receives the money and has the weakest auth. Every
 * control built for brands protects brands — so these methods return only what a
 * creator needs, and nothing about the brand's other deals, balances or
 * reviewers.
 */

export interface CreatorMilestoneView {
  readonly milestoneId: string;
  readonly title: string;
  readonly amountMinor: bigint;
  readonly satisfied: boolean;
  readonly reason: string;
  readonly releasedAt: Date | null;
}

export interface CreatorDealView {
  readonly dealId: string;
  readonly brandName: string;
  readonly campaignName: string;
  readonly state: string;
  readonly totalMinor: bigint;
  readonly earnedMinor: bigint;
  readonly currency: string;
  readonly milestones: readonly CreatorMilestoneView[];
  readonly deliverables: ReadonlyArray<{
    deliverableId: string;
    slot: string;
    state: string;
    brief: string | null;
    latestVersion: number;
    latestComment: string | null;
  }>;
  readonly nextUnlock: CreatorMilestoneView | null;
}

@Injectable()
export class CreatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listDeals(creatorUserId: string): Promise<CreatorDealView[]> {
    const deals = await this.prisma.deal.findMany({
      where: {
        creatorUserId,
        // A draft deal is one the brand has not offered yet. Showing it would
        // tell a creator about work they have not been asked to do.
        state: { in: ['offered', 'accepted', 'active', 'completed'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    const views: CreatorDealView[] = [];
    for (const deal of deals) {
      views.push(await this.dealView(deal.id, creatorUserId));
    }
    return views;
  }

  async getDeal(dealId: string, creatorUserId: string): Promise<CreatorDealView> {
    return this.dealView(dealId, creatorUserId);
  }

  /**
   * Submits work.
   *
   * Creates a NEW submission version. A revision never edits the previous
   * attempt — a dispute must be able to show attempt 1, what was said about it,
   * and attempt 2 side by side, and an edit destroys exactly that.
   */
  async submit(input: {
    deliverableId: string;
    creatorUserId: string;
    assetKey: string;
    caption?: string | undefined;
    context: RequestContext;
  }): Promise<{ submissionId: string; version: number }> {
    const deliverable = await this.prisma.deliverable.findFirst({
      // The creator predicate is in the WHERE clause, so someone else's
      // deliverable simply does not exist here.
      where: { id: input.deliverableId, deal: { creatorUserId: input.creatorUserId } },
      select: {
        id: true,
        state: true,
        version: true,
        dealId: true,
        deal: { select: { state: true, organizationId: true } },
        submissions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } },
      },
    });

    if (!deliverable) throw new NotFoundException('No such deliverable.');

    if (deliverable.state === 'approved') {
      throw new ConflictException('This one has already been approved.');
    }
    if (deliverable.state === 'cancelled') {
      throw new ConflictException('This deliverable was cancelled.');
    }
    if (!['active', 'accepted'].includes(deliverable.deal.state)) {
      // Submitting into a completed or cancelled deal would create work nobody
      // agreed to pay for.
      throw new ConflictException('This deal is not accepting submissions.');
    }

    const nextVersion = (deliverable.submissions[0]?.version ?? 0) + 1;

    const submission = await this.prisma.$transaction(async (tx) => {
      const created = await tx.submission.create({
        data: {
          deliverableId: deliverable.id,
          version: nextVersion,
          assetKey: input.assetKey,
          caption: input.caption ?? null,
        },
        select: { id: true, version: true },
      });

      // Guarded on the version read, so two submissions racing cannot both
      // advance the deliverable.
      const { count } = await tx.deliverable.updateMany({
        where: { id: deliverable.id, version: deliverable.version },
        data: { state: 'in_review', version: { increment: 1 } },
      });
      if (count === 0) {
        throw new ConflictException('Something else changed this deliverable. Try again.');
      }

      return created;
    });

    await this.audit.record({
      action: AuditAction.DeliverableSubmitted,
      actorUserId: input.creatorUserId,
      organizationId: deliverable.deal.organizationId,
      subjectType: 'deliverable',
      subjectId: deliverable.id,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      data: { submissionId: submission.id, version: submission.version },
    });

    return { submissionId: submission.id, version: submission.version };
  }

  /**
   * Three figures, deliberately distinct.
   *
   * Collapsing them into one number would tell a creator they have money they
   * cannot spend. `agreedNotYetUnlocked` in particular is NOT called "pending"
   * or "earned": it is what the deals are worth if the work is approved, and
   * anything stronger is the product making a promise the brand has not.
   */
  async earnings(creatorUserId: string): Promise<{
    paidOutMinor: bigint;
    awaitingPayoutMinor: bigint;
    agreedNotYetUnlockedMinor: bigint;
    currency: string;
  }> {
    const deals = await this.listDeals(creatorUserId);

    let released = 0n;
    let unlocked = 0n;
    let outstanding = 0n;

    for (const deal of deals) {
      for (const milestone of deal.milestones) {
        if (milestone.releasedAt) released += milestone.amountMinor;
        else if (milestone.satisfied) unlocked += milestone.amountMinor;
        else outstanding += milestone.amountMinor;
      }
    }

    return {
      // Payout tracking lands with the payout schedule. Until then everything
      // released is reported as awaiting payout rather than as paid — claiming
      // money reached a bank account when we have not checked is the one
      // direction this must never be wrong in.
      paidOutMinor: 0n,
      awaitingPayoutMinor: released + unlocked,
      agreedNotYetUnlockedMinor: outstanding,
      currency: deals[0]?.currency ?? 'USD',
    };
  }

  private async dealView(dealId: string, creatorUserId: string): Promise<CreatorDealView> {
    const deal = await this.prisma.deal.findFirst({
      where: { id: dealId, creatorUserId },
      select: {
        id: true,
        state: true,
        totalAmountMinor: true,
        currency: true,
        campaign: {
          select: {
            name: true,
            // The brand name reaches here through the campaign's workspace.
            // `Deal` deliberately carries no `organization` relation of its own:
            // its composite FK to `campaign(id, organizationId)` already makes
            // the org a database fact, and a second path to the same value is a
            // second thing that can disagree.
            workspace: { select: { organization: { select: { name: true } } } },
          },
        },
        deliverables: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            state: true,
            brief: true,
            submissions: {
              orderBy: { version: 'desc' },
              take: 1,
              select: {
                version: true,
                reviews: {
                  where: { voidedAt: null },
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { comment: true },
                },
              },
            },
          },
        },
      },
    });

    if (!deal) throw new NotFoundException('No such deal.');

    const milestoneRows = await this.prisma.milestone.findMany({
      where: {
        dealId: deal.id,
        agreementVersion: { supersededAt: null, creatorAcceptedAt: { not: null } },
      },
      orderBy: { sequence: 'asc' },
      select: {
        id: true,
        sequence: true,
        title: true,
        amountMinor: true,
        condition: true,
        releasedAt: true,
      },
    });

    const live = deal.deliverables.filter((row) => row.state !== 'cancelled');

    const facts: DealFacts = {
      approvedDeliverableIds: new Set(
        live.filter((row) => row.state === 'approved').map((row) => row.id),
      ),
      totalDeliverables: live.length,
      manuallyApprovedMilestoneIds: new Set(),
      now: new Date(),
    };

    // The SAME engine the release path uses. The sentence a creator reads about
    // what unlocks their next payment is produced by the function that decides
    // whether it unlocks — so this screen cannot promise what the engine will
    // not do.
    const evaluation = evaluateDeal(
      milestoneRows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        amountMinor: row.amountMinor,
        releasedAt: row.releasedAt,
        condition: row.condition as unknown as MilestoneCondition,
      })),
      facts,
    );

    const titles = new Map(milestoneRows.map((row) => [row.id, row.title]));
    const releasedAt = new Map(milestoneRows.map((row) => [row.id, row.releasedAt]));

    const milestones: CreatorMilestoneView[] = evaluation.verdicts.map((verdict) => ({
      milestoneId: verdict.milestoneId,
      title: titles.get(verdict.milestoneId) ?? 'Milestone',
      amountMinor: verdict.amountMinor,
      satisfied: verdict.satisfied,
      reason: verdict.reason,
      releasedAt: releasedAt.get(verdict.milestoneId) ?? null,
    }));

    return {
      dealId: deal.id,
      brandName: deal.campaign.workspace.organization.name,
      campaignName: deal.campaign.name,
      state: deal.state,
      totalMinor: deal.totalAmountMinor,
      // Money that has ACTUALLY moved. Never anything merely approved — the
      // release job may not have run, and it may yet fail.
      earnedMinor: milestones
        .filter((milestone) => milestone.releasedAt !== null)
        .reduce((total, milestone) => total + milestone.amountMinor, 0n),
      currency: deal.currency,
      milestones,
      deliverables: deal.deliverables.map((row) => ({
        deliverableId: row.id,
        slot: `Video ${row.sequence} of ${live.length}`,
        state: row.state,
        brief: row.brief,
        latestVersion: row.submissions[0]?.version ?? 0,
        latestComment: row.submissions[0]?.reviews[0]?.comment ?? null,
      })),
      nextUnlock: evaluation.nextUnlock
        ? (milestones.find(
            (milestone) => milestone.milestoneId === evaluation.nextUnlock!.milestoneId,
          ) ?? null)
        : null,
    };
  }
}
