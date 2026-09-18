import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ConditionType,
  MilestoneAmountsError,
  Money,
  assertCurrency,
  evaluateCondition,
  isSatisfiableAtStart,
  resolveMilestoneAmounts,
  type MilestoneCondition,
} from '@rayi/domain';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

import { BUDGET_PORT, type BudgetPort } from '../workspaces/public/budget.port';

/**
 * Deals, from the brand's side.
 *
 * Four rules run through this file, and each one is a way money went wrong in
 * the design review:
 *
 * **Percentages are authoring input, never the authoritative value.** They are
 * resolved once, at the point the deal is created, and the resolved minor units
 * are frozen on the row. Re-evaluating at release time means amending a deal
 * total silently rewrites the amount of an ALREADY-RELEASED milestone.
 *
 * **The advance disclosure is derived, not declared.** `isSatisfiableAtStart`
 * evaluates the condition against an empty deal, so `count: 0` and a past date
 * are caught exactly like `ADVANCE`. A brand cannot sidestep the warning by
 * expressing the same thing a different way.
 *
 * **Offering commits against the envelope with a conditional UPDATE.** Two
 * concurrent offers cannot both pass a ceiling that only funds one.
 *
 * **Terminating releases nothing and claws nothing back.** Money already
 * released stays released — payout is final — and only the uncommitted
 * remainder returns.
 */

/** States where money is actually held against a campaign and not yet paid. */
const COMMITTED_STATES = ['offered', 'accepted', 'active'] as const;

export interface MilestoneDraft {
  readonly title: string;
  readonly amountMinor?: bigint | undefined;
  readonly percentageBps?: number | undefined;
  readonly condition: MilestoneCondition;
}

export interface DealDraft {
  readonly campaignId: string;
  readonly creatorHandle: string;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly deliverables: ReadonlyArray<{
    slot: string;
    brief: string | null;
    dueAt: Date | null;
  }>;
  readonly milestones: readonly MilestoneDraft[];
}

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
    @Inject(BUDGET_PORT) private readonly budget: BudgetPort,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    organizationId: string,
    filters: { campaignId?: string; state?: string; creatorId?: string },
  ) {
    const deals = await this.prisma.deal.findMany({
      where: {
        // Always both. Scope is part of the query, never a comparison afterwards.
        organizationId,
        ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
        ...(filters.state ? { state: filters.state } : {}),
        ...(filters.creatorId ? { creatorUserId: filters.creatorId } : {}),
      },
      select: {
        id: true,
        campaignId: true,
        creatorUserId: true,
        totalAmountMinor: true,
        currency: true,
        state: true,
        acceptedAt: true,
        createdAt: true,
        campaign: { select: { name: true } },
        creator: { select: { username: true } },
        deliverables: { select: { state: true } },
        agreements: {
          where: { supersededAt: null },
          select: { milestones: { select: { amountMinor: true, releasedAt: true } } },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const rows = deals.map((deal) => {
      const milestones = deal.agreements[0]?.milestones ?? [];
      const releasedMinor = milestones.reduce(
        (sum, milestone) => (milestone.releasedAt ? sum + milestone.amountMinor : sum),
        0n,
      );
      return {
        dealId: deal.id,
        campaignId: deal.campaignId,
        campaignName: deal.campaign.name,
        creatorId: deal.creatorUserId,
        creatorHandle: `@${deal.creator.username}`,
        state: deal.state,
        totalMinor: deal.totalAmountMinor,
        currency: deal.currency,
        releasedMinor,
        deliverablesTotal: deal.deliverables.length,
        deliverablesApproved: deal.deliverables.filter((row) => row.state === 'approved').length,
        createdAt: deal.createdAt,
        acceptedAt: deal.acceptedAt,
      };
    });

    /*
     * `committed` counts only the states where money is actually held and
     * unpaid.
     *
     * A draft promises nobody anything, a completed deal is already paid in
     * full, and a terminated one returned its remainder. Summing every deal's
     * total and calling it "committed" overstates a brand's outstanding
     * obligation by every deal they ever finished — which is the figure someone
     * screenshots into a board deck.
     */
    const committedMinor = rows.reduce(
      (sum, row) =>
        (COMMITTED_STATES as readonly string[]).includes(row.state) ? sum + row.totalMinor : sum,
      0n,
    );
    const releasedMinor = rows.reduce((sum, row) => sum + row.releasedMinor, 0n);

    return {
      deals: rows,
      currency: rows[0]?.currency ?? 'USD',
      committedMinor,
      releasedMinor,
    };
  }

  async get(organizationId: string, dealId: string) {
    const deal = await this.prisma.deal.findFirst({
      where: { id: dealId, organizationId },
      select: {
        id: true,
        campaignId: true,
        creatorUserId: true,
        totalAmountMinor: true,
        currency: true,
        state: true,
        acceptedAt: true,
        createdAt: true,
        campaign: { select: { name: true, workspaceId: true } },
        creator: { select: { username: true } },
        deliverables: {
          select: {
            id: true,
            sequence: true,
            brief: true,
            state: true,
            version: true,
            dueAt: true,
          },
          orderBy: { sequence: 'asc' },
        },
        agreements: {
          select: {
            version: true,
            totalAmountMinor: true,
            createdAt: true,
            creatorAcceptedAt: true,
            supersededAt: true,
            milestones: {
              select: {
                id: true,
                sequence: true,
                title: true,
                amountMinor: true,
                authoredBasisPoints: true,
                condition: true,
                releasedAt: true,
              },
              orderBy: { sequence: 'asc' },
            },
          },
          orderBy: { version: 'desc' },
        },
      },
    });

    if (!deal) throw new NotFoundException();

    const live = deal.agreements.find((agreement) => agreement.supersededAt === null);
    const approvedIds = new Set(
      deal.deliverables.filter((row) => row.state === 'approved').map((row) => row.id),
    );
    const now = new Date();

    const milestones = (live?.milestones ?? []).map((milestone) => {
      const condition = milestone.condition as unknown as MilestoneCondition;
      // The engine's OWN verdict, from the same function that decides whether
      // money moves — so this screen cannot promise what the engine will not do.
      const verdict = evaluateCondition(condition, milestone.id, {
        approvedDeliverableIds: approvedIds,
        totalDeliverables: deal.deliverables.length,
        manuallyApprovedMilestoneIds: new Set(),
        now,
      });
      return {
        milestoneId: milestone.id,
        title: milestone.title,
        amountMinor: milestone.amountMinor,
        percentageBps: milestone.authoredBasisPoints,
        condition,
        satisfied: verdict.satisfied,
        reason: verdict.reason,
        releasedAt: milestone.releasedAt,
        // DERIVED. Typing a condition differently does not hide an advance.
        satisfiableAtStart: isSatisfiableAtStart(condition, now),
      };
    });

    const total = deal.deliverables.length;

    return {
      dealId: deal.id,
      campaignId: deal.campaignId,
      campaignName: deal.campaign.name,
      workspaceId: deal.campaign.workspaceId,
      creatorId: deal.creatorUserId,
      creatorHandle: `@${deal.creator.username}`,
      state: deal.state,
      totalMinor: deal.totalAmountMinor,
      currency: deal.currency,
      releasedMinor: milestones.reduce(
        (sum, milestone) => (milestone.releasedAt ? sum + milestone.amountMinor : sum),
        0n,
      ),
      deliverablesTotal: total,
      deliverablesApproved: approvedIds.size,
      createdAt: deal.createdAt,
      acceptedAt: deal.acceptedAt,
      milestones,
      deliverables: deal.deliverables.map((row) => ({
        deliverableId: row.id,
        slot: `Video ${row.sequence} of ${total}`,
        brief: row.brief,
        state: row.state,
        latestVersion: row.version,
        dueAt: row.dueAt,
      })),
      agreementVersions: deal.agreements.map((agreement) => ({
        version: agreement.version,
        createdAt: agreement.createdAt,
        acceptedAt: agreement.creatorAcceptedAt,
        totalMinor: agreement.totalAmountMinor,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Preview — pure, creates nothing
  // -------------------------------------------------------------------------

  /**
   * Resolve a draft without creating anything.
   *
   * This is what makes the authoring UI unable to lie: the percentages, the odd
   * cents and the advance disclosure all come from the SAME functions the real
   * creation path uses. A client-side preview would be a second implementation
   * of money arithmetic, and the two would disagree on exactly the inputs
   * nobody tested — a brand would consent to one figure and a different one
   * would be stored.
   */
  preview(draft: DealDraft, now: Date = new Date()) {
    const currency = assertCurrency(draft.currency);
    const problems: string[] = [];

    if (draft.totalMinor <= 0n) problems.push('The deal total must be more than zero.');
    if (draft.deliverables.length === 0) problems.push('A deal needs at least one deliverable.');

    // A deal with no milestones is a deal with ONE final milestone paying the
    // whole total — the ordinary case, and it must stay a one-step action rather
    // than forcing a brand through a schedule builder.
    const authored: MilestoneDraft[] =
      draft.milestones.length > 0
        ? [...draft.milestones]
        : [
            {
              title: 'On completion',
              amountMinor: draft.totalMinor,
              condition: { type: ConditionType.AllDeliverablesApproved },
            },
          ];

    let resolved = new Map<number, bigint>();
    if (draft.totalMinor > 0n) {
      try {
        resolved = resolveMilestoneAmounts(
          authored.map((milestone, index) =>
            milestone.percentageBps != null
              ? { sequence: index, kind: 'percentage' as const, basisPoints: milestone.percentageBps }
              : {
                  sequence: index,
                  kind: 'fixed' as const,
                  amountMinor: milestone.amountMinor ?? 0n,
                },
          ),
          Money.of(draft.totalMinor, currency),
        );
      } catch (error) {
        if (error instanceof MilestoneAmountsError) {
          problems.push(error.message);
        } else {
          throw error;
        }
      }
    }

    const milestones = authored.map((milestone, index) => {
      const amountMinor = resolved.get(index) ?? milestone.amountMinor ?? 0n;
      const satisfiableAtStart = isSatisfiableAtStart(milestone.condition, now);
      const verdict = evaluateCondition(milestone.condition, `preview-${index}`, {
        approvedDeliverableIds: new Set(),
        totalDeliverables: draft.deliverables.length,
        manuallyApprovedMilestoneIds: new Set(),
        now,
      });
      return {
        title: milestone.title,
        amountMinor,
        percentageBps: milestone.percentageBps ?? null,
        condition: milestone.condition,
        satisfiableAtStart,
        reason: satisfiableAtStart
          ? 'Releases as soon as the creator accepts — before any work exists.'
          : verdict.reason,
      };
    });

    const milestoneTotalMinor = milestones.reduce(
      (sum, milestone) => sum + milestone.amountMinor,
      0n,
    );
    const advanceTotalMinor = milestones.reduce(
      (sum, milestone) => (milestone.satisfiableAtStart ? sum + milestone.amountMinor : sum),
      0n,
    );

    return {
      milestones,
      milestoneTotalMinor,
      totalMinor: draft.totalMinor,
      currency,
      balances: milestoneTotalMinor === draft.totalMinor,
      advanceTotalMinor,
      problems,
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(organizationId: string, draft: DealDraft, actorUserId: string, context: RequestContext) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: draft.campaignId, organizationId },
      select: { id: true, currency: true, state: true },
    });
    if (!campaign) throw new NotFoundException();

    const preview = this.preview(draft);
    if (preview.problems.length > 0) {
      throw new BadRequestException(preview.problems.join(' '));
    }

    const creator = await this.prisma.user.findFirst({
      where: { username: draft.creatorHandle.replace(/^@/, '') },
      select: { id: true },
    });
    if (!creator) {
      throw new NotFoundException(
        'No creator with that handle. They need to have signed in at least once.',
      );
    }

    const existing = await this.prisma.deal.findFirst({
      where: { campaignId: draft.campaignId, creatorUserId: creator.id },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'This creator already has a deal in this campaign. Two would make "what did we agree" ' +
          'unanswerable, and both would independently bound the payout.',
      );
    }

    const dealId = await this.prisma.$transaction(async (tx) => {
      const deal = await tx.deal.create({
        data: {
          organizationId,
          campaignId: draft.campaignId,
          creatorUserId: creator.id,
          totalAmountMinor: draft.totalMinor,
          currency: preview.currency,
          state: 'draft',
        },
        select: { id: true },
      });

      const agreement = await tx.agreementVersion.create({
        data: { dealId: deal.id, version: 1, totalAmountMinor: draft.totalMinor },
        select: { id: true },
      });

      await tx.milestone.createMany({
        data: preview.milestones.map((milestone, index) => ({
          agreementVersionId: agreement.id,
          dealId: deal.id,
          sequence: index,
          title: milestone.title,
          // The RESOLVED amount is what is stored. The percentage survives for
          // display and for authoring the next version only, and is never read
          // at release time.
          amountMinor: milestone.amountMinor,
          authoredBasisPoints: milestone.percentageBps,
          condition: milestone.condition as object,
        })),
      });

      await tx.deliverable.createMany({
        data: draft.deliverables.map((deliverable, index) => ({
          dealId: deal.id,
          sequence: index + 1,
          brief: deliverable.brief,
          dueAt: deliverable.dueAt,
        })),
      });

      return deal.id;
    });

    await this.audit.record({
      action: AuditAction.DealCreated,
      organizationId,
      actorUserId,
      subjectType: 'deal',
      subjectId: dealId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: {
        campaignId: draft.campaignId,
        totalMinor: draft.totalMinor.toString(),
        milestoneCount: preview.milestones.length,
        advanceMinor: preview.advanceTotalMinor.toString(),
      },
    });

    return this.get(organizationId, dealId);
  }

  /**
   * Offer the deal to the creator.
   *
   * Commits the total against the workspace envelope FIRST, and refuses if the
   * ceiling cannot take it. The commitment happens before the state change so a
   * refused offer leaves nothing behind — a deal marked `offered` against a
   * ceiling that could not fund it would be a promise the system cannot keep.
   */
  async offer(
    organizationId: string,
    dealId: string,
    input: { acknowledgedAdvanceMinor: bigint; code?: string | undefined },
    actorUserId: string,
    context: RequestContext,
  ) {
    const deal = await this.get(organizationId, dealId);
    if (deal.state !== 'draft') {
      throw new ConflictException('Only a draft can be offered.');
    }

    const advanceMinor = deal.milestones.reduce(
      (sum, milestone) =>
        milestone.satisfiableAtStart && !milestone.releasedAt
          ? sum + milestone.amountMinor
          : sum,
      0n,
    );

    /*
     * The client's figure is an ASSERTION, never an instruction.
     *
     * The server re-derives the advance from the deal and refuses on mismatch,
     * so a stale authoring screen cannot consent on a brand's behalf to money
     * that leaves before work exists. No number sent from a client becomes a
     * number the server pays.
     */
    if (input.acknowledgedAdvanceMinor !== advanceMinor) {
      throw new ConflictException(
        `This deal releases ${advanceMinor} minor units on acceptance, not ` +
          `${input.acknowledgedAdvanceMinor}. Reload and check the figure before sending it.`,
      );
    }

    if (advanceMinor > 0n) {
      if (!input.code) {
        throw new BadRequestException('Sending money needs a fresh security check.');
      }
      const resourceHash = StepUpService.resourceHash({
        dealId,
        organizationId,
        advanceMinor: advanceMinor.toString(),
      });
      await this.stepUp.mint({
        userId: actorUserId,
        purpose: StepUpPurpose.OfferDeal,
        code: input.code,
        resourceHash,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
      await this.stepUp.consume({
        userId: actorUserId,
        purpose: StepUpPurpose.OfferDeal,
        resourceHash,
      });
    }

    const committed = await this.budget.tryCommit(
      organizationId,
      deal.workspaceId,
      deal.totalMinor,
    );
    if (!committed) {
      throw new ConflictException(
        'This workspace has used its whole approved budget, so no new deal can be offered from ' +
          'it. Deals already accepted are unaffected. Ask finance to raise the ceiling.',
      );
    }

    const offeredAt = new Date();
    try {
      const updated = await this.prisma.deal.updateMany({
        // `state: 'draft'` in the predicate makes this a compare-and-set: two
        // concurrent offers cannot both transition the same deal.
        where: { id: dealId, organizationId, state: 'draft' },
        data: { state: 'offered' },
      });
      if (updated.count === 0) throw new ConflictException('Only a draft can be offered.');
    } catch (error) {
      // The commitment must not survive a failed transition, or the envelope
      // holds money against a deal that was never offered.
      await this.budget.release(organizationId, deal.workspaceId, deal.totalMinor);
      throw error;
    }

    await this.audit.record({
      action: AuditAction.DealOffered,
      organizationId,
      actorUserId,
      subjectType: 'deal',
      subjectId: dealId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: {
        totalMinor: deal.totalMinor.toString(),
        advanceMinor: advanceMinor.toString(),
        workspaceId: deal.workspaceId,
      },
    });

    return { dealId, state: 'offered' as const, offeredAt };
  }

  /**
   * End a deal early.
   *
   * **Releases nothing and claws nothing back.** Money already released stays
   * with the creator, because payout is final; only the uncommitted remainder
   * returns to the workspace ceiling.
   */
  async terminate(
    organizationId: string,
    dealId: string,
    input: { reason: string; code: string },
    actorUserId: string,
    context: RequestContext,
  ) {
    const deal = await this.get(organizationId, dealId);
    if (!(COMMITTED_STATES as readonly string[]).includes(deal.state)) {
      throw new ConflictException('This deal is not running.');
    }

    const resourceHash = StepUpService.resourceHash({ dealId, organizationId });
    await this.stepUp.mint({
      userId: actorUserId,
      purpose: StepUpPurpose.TerminateDeal,
      code: input.code,
      resourceHash,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    await this.stepUp.consume({
      userId: actorUserId,
      purpose: StepUpPurpose.TerminateDeal,
      resourceHash,
    });

    // What comes BACK. Released money is not in this figure — nothing claws it
    // back, and a "returned" total that included it would be a lie about where
    // the money is.
    const returnedMinor = deal.totalMinor - deal.releasedMinor;

    const updated = await this.prisma.deal.updateMany({
      where: { id: dealId, organizationId, state: { in: [...COMMITTED_STATES] } },
      data: { state: 'terminated', cancelledAt: new Date() },
    });
    if (updated.count === 0) throw new ConflictException('This deal is not running.');

    await this.budget.release(organizationId, deal.workspaceId, returnedMinor);

    await this.audit.record({
      action: AuditAction.DealTerminated,
      organizationId,
      actorUserId,
      subjectType: 'deal',
      subjectId: dealId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: {
        reason: input.reason,
        returnedMinor: returnedMinor.toString(),
        releasedMinor: deal.releasedMinor.toString(),
      },
    });

    return {
      dealId,
      state: 'terminated' as const,
      returnedMinor,
      currency: deal.currency,
    };
  }
}
