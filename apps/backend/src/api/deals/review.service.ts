import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  evaluateDeal,
  type DealFacts,
  type MilestoneCondition,
  type MilestoneInput,
} from '@rayi/domain';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { PermissionService } from '@/authorization/permission.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * Reviewing a submission, and what it sets in motion.
 *
 * **Approval permission is money authority in disguise**, and that is the single
 * most important thing about this file. Approving a deliverable can
 * deterministically satisfy a milestone, and a satisfied milestone releases
 * funds — so an "approve" button gated only on a reviewer permission is a way to
 * move money without ever holding money authority.
 *
 * So the check is two-stage and matches the shape used everywhere else: a role
 * permits the ACTION, and a `MoneyAuthority` row permits the CONSEQUENCE. An
 * approval that would satisfy a milestone requires both. One that would not is
 * an ordinary review.
 *
 * That split is also what lets a non-money reviewer keep working: they can
 * approve anything that does not tip a milestone, and the three-second review
 * queue is unaffected for the overwhelming majority of rows.
 */

/**
 * How long an approval can be undone before the release job acts.
 *
 * Long enough to be a real undo, short enough that a creator watching the app
 * does not sit looking at nothing. Auto-release on brand silence has NO hold, so
 * this window never reaches the creator's signature moment.
 */
export const UNDO_WINDOW_MS = 30_000;

export interface ApprovalOutcome {
  readonly reviewId: string;
  readonly deliverableId: string;
  /** Milestones this approval has just satisfied. Empty for an ordinary approval. */
  readonly satisfiedMilestoneIds: readonly string[];
  readonly totalToReleaseMinor: bigint;
  /** When the release job may act. Until then the approval can be undone. */
  readonly releasesAt: Date;
}

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Approves a submission.
   *
   * **Writes no ledger entry.** It transitions state and leaves the release to a
   * job that runs after the undo window — which honours the rule that the api
   * process never does money work inline, and gives every approval a genuinely
   * cancellable undo that never touches Stripe.
   */
  async approve(input: {
    submissionId: string;
    organizationId: string;
    actorUserId: string;
    actorKind?: 'HUMAN' | 'SYSTEM_AUTO';
    comment?: string | undefined;
    voiceKey?: string | undefined;
    context: RequestContext;
  }): Promise<ApprovalOutcome> {
    const actorKind = input.actorKind ?? 'HUMAN';

    const submission = await this.loadSubmission(input.submissionId, input.organizationId);
    const { deliverable } = submission;

    if (deliverable.state === 'approved') {
      throw new ConflictException('This deliverable has already been approved.');
    }
    if (deliverable.state === 'cancelled') {
      throw new ConflictException('This deliverable was cancelled.');
    }

    // WOULD this approval satisfy a milestone? Asked BEFORE the approval is
    // written, against the state as it would be afterwards — because the answer
    // decides which authority is required, and asking afterwards would mean the
    // check ran too late to refuse.
    const wouldSatisfy = await this.wouldSatisfyMilestones(deliverable.dealId, deliverable.id);

    if (actorKind === 'HUMAN') {
      await this.assertMayApprove({
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        movesMoney: wouldSatisfy.milestoneIds.length > 0,
        amountMinor: wouldSatisfy.totalMinor,
      });
    }

    const reviewId = await this.prisma
      .$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            submissionId: submission.id,
            deliverableId: deliverable.id,
            decision: 'APPROVED',
            actorKind,
            // A system decision must not pretend to have an author. The CHECK
            // constraint enforces the pairing; this is the code side of it.
            actorUserId: actorKind === 'HUMAN' ? input.actorUserId : null,
            comment: input.comment ?? null,
            voiceKey: input.voiceKey ?? null,
          },
          select: { id: true },
        });

        // Guarded on the version we read. Two reviewers approving the same
        // deliverable at once cannot both win — and the partial unique index on
        // `(deliverableId) WHERE decision='APPROVED' AND voidedAt IS NULL` is the
        // backstop if they somehow do.
        const { count } = await tx.deliverable.updateMany({
          where: { id: deliverable.id, version: deliverable.version },
          data: { state: 'approved', approvedAt: new Date(), version: { increment: 1 } },
        });

        if (count === 0) {
          throw new ConflictException('Someone else acted on this deliverable. Reload and retry.');
        }

        return review.id;
      })
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // The partial unique index. Two live approvals on one deliverable
          // would make it count twice toward "N videos approved" — a silent
          // overpay — so the storage engine refuses.
          throw new ConflictException('This deliverable has already been approved.');
        }
        throw error;
      });

    await this.audit.record({
      action: AuditAction.DeliverableApproved,
      actorUserId: actorKind === 'HUMAN' ? input.actorUserId : null,
      organizationId: input.organizationId,
      subjectType: 'deliverable',
      subjectId: deliverable.id,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      data: {
        reviewId,
        actorKind,
        satisfiesMilestones: wouldSatisfy.milestoneIds,
        // The amount this approval puts in motion. Recorded because "who
        // authorised this payment" must be answerable, and the answer is
        // whoever pressed approve.
        releasesMinor: wouldSatisfy.totalMinor.toString(),
      },
    });

    return {
      reviewId,
      deliverableId: deliverable.id,
      satisfiedMilestoneIds: wouldSatisfy.milestoneIds,
      totalToReleaseMinor: wouldSatisfy.totalMinor,
      releasesAt: new Date(Date.now() + UNDO_WINDOW_MS),
    };
  }

  /**
   * Undoes an approval.
   *
   * **Voids the review; never deletes it.** Deleting is impossible under the
   * append-only discipline and would erase the fact that a decision was made —
   * which a dispute needs.
   *
   * **And deleting the queued release job is NOT the interlock.** The worker can
   * claim that job between the click and the delete, which is a TOCTOU race with
   * money on the other side. The job instead re-derives from the database at run
   * time and aborts on any voided approval, so the void alone is sufficient and
   * the job's existence is irrelevant.
   */
  async undoApproval(input: {
    reviewId: string;
    organizationId: string;
    actorUserId: string;
    context: RequestContext;
  }): Promise<void> {
    const review = await this.prisma.review.findFirst({
      where: {
        id: input.reviewId,
        decision: 'APPROVED',
        voidedAt: null,
        submission: { deliverable: { deal: { organizationId: input.organizationId } } },
      },
      select: { id: true, deliverableId: true, createdAt: true },
    });

    if (!review) throw new NotFoundException('No such approval.');

    if (Date.now() - review.createdAt.getTime() > UNDO_WINDOW_MS) {
      // Past the window, the release job may already have run. Refusing here is
      // honest: the alternative is an undo that sometimes silently does nothing,
      // which is worse than one that says it is too late.
      throw new ConflictException('Too late to undo — this has already been released.');
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.review.updateMany({
        // Guarded on `voidedAt: null` so two undos cannot both claim to have
        // been the one that worked.
        where: { id: review.id, voidedAt: null },
        data: { voidedAt: new Date(), voidedBy: input.actorUserId },
      });
      if (count === 0) throw new ConflictException('This approval was already undone.');

      // Back to in_review, not to pending. The work was submitted and is still
      // submitted; only the decision was withdrawn.
      await tx.deliverable.update({
        where: { id: review.deliverableId },
        data: { state: 'in_review', approvedAt: null, version: { increment: 1 } },
      });
    });

    await this.audit.record({
      action: AuditAction.DeliverableApprovalUndone,
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      subjectType: 'deliverable',
      subjectId: review.deliverableId,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      data: { reviewId: review.id },
    });
  }

  /** Sends work back for changes. Never satisfies a milestone, so no money check. */
  async requestChanges(input: {
    submissionId: string;
    organizationId: string;
    actorUserId: string;
    comment?: string | undefined;
    voiceKey?: string | undefined;
    context: RequestContext;
  }): Promise<{ reviewId: string }> {
    const submission = await this.loadSubmission(input.submissionId, input.organizationId);

    const permitted = await this.permissions.can(input.actorUserId, 'deliverable:review', {
      organizationId: input.organizationId,
    });
    if (!permitted) throw new NotFoundException('Not found.');

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          submissionId: submission.id,
          deliverableId: submission.deliverable.id,
          decision: 'CHANGES_REQUESTED',
          actorKind: 'HUMAN',
          actorUserId: input.actorUserId,
          comment: input.comment ?? null,
          voiceKey: input.voiceKey ?? null,
        },
        select: { id: true },
      });

      await tx.deliverable.updateMany({
        where: { id: submission.deliverable.id, version: submission.deliverable.version },
        data: { state: 'changes_requested', version: { increment: 1 } },
      });

      return created;
    });

    await this.audit.record({
      action: AuditAction.DeliverableChangesRequested,
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      subjectType: 'deliverable',
      subjectId: submission.deliverable.id,
      requestId: input.context.requestId ?? null,
      data: { reviewId: review.id },
    });

    return { reviewId: review.id };
  }

  /**
   * Which milestones this deliverable's approval would satisfy.
   *
   * Evaluated with the deliverable counted as approved — the state as it WOULD
   * be — because the answer decides which authority is required, and asking
   * after the write would mean the check ran too late to refuse.
   */
  private async wouldSatisfyMilestones(
    dealId: string,
    deliverableId: string,
  ): Promise<{ milestoneIds: string[]; totalMinor: bigint }> {
    const before = await this.dealFacts(dealId);
    const milestones = await this.milestonesOf(dealId);

    const after: DealFacts = {
      ...before,
      approvedDeliverableIds: new Set([...before.approvedDeliverableIds, deliverableId]),
    };

    const satisfiedBefore = new Set(
      evaluateDeal(milestones, before).toRelease.map((verdict) => verdict.milestoneId),
    );
    const newlySatisfied = evaluateDeal(milestones, after).toRelease.filter(
      (verdict) => !satisfiedBefore.has(verdict.milestoneId),
    );

    return {
      milestoneIds: newlySatisfied.map((verdict) => verdict.milestoneId),
      totalMinor: newlySatisfied.reduce((total, verdict) => total + verdict.amountMinor, 0n),
    };
  }

  /**
   * The two-stage check.
   *
   * A role permits the ACTION; a `MoneyAuthority` row permits the CONSEQUENCE.
   * An approval that would release funds needs both, and the per-transaction
   * limit applies to the amount this one approval puts in motion.
   */
  private async assertMayApprove(input: {
    actorUserId: string;
    organizationId: string;
    movesMoney: boolean;
    amountMinor: bigint;
  }): Promise<void> {
    const permitted = await this.permissions.can(input.actorUserId, 'deliverable:review', {
      organizationId: input.organizationId,
    });
    if (!permitted) throw new NotFoundException('Not found.');

    if (!input.movesMoney) return;

    const authority = await this.permissions.hasMoneyAuthority(
      input.actorUserId,
      'deliverable:release',
      { organizationId: input.organizationId },
      input.amountMinor,
    );

    if (!authority.granted) {
      this.logger.warn(
        `Approval refused for ${input.actorUserId}: it would release ${input.amountMinor} ` +
          `and money authority is ${authority.reason}.`,
      );
      throw new ForbiddenException(
        authority.reason === 'exceeds_limit'
          ? 'Approving this would release more than your approval limit. Ask someone with a higher limit.'
          : 'Approving this would release funds, which needs authority you do not have. ' +
            'Someone with that authority can approve it.',
      );
    }
  }

  private async dealFacts(dealId: string): Promise<DealFacts> {
    const deliverables = await this.prisma.deliverable.findMany({
      where: { dealId, state: { not: 'cancelled' } },
      select: { id: true, state: true },
    });

    return {
      approvedDeliverableIds: new Set(
        deliverables.filter((row) => row.state === 'approved').map((row) => row.id),
      ),
      totalDeliverables: deliverables.length,
      // Manual milestone approvals land with the milestone surface. An empty set
      // means those conditions read as unsatisfied, which is the safe direction.
      manuallyApprovedMilestoneIds: new Set(),
      now: new Date(),
    };
  }

  private async milestonesOf(dealId: string): Promise<MilestoneInput[]> {
    const milestones = await this.prisma.milestone.findMany({
      where: {
        dealId,
        // The LIVE agreement only. A superseded version's milestones describe
        // terms that are no longer in force.
        agreementVersion: { supersededAt: null, creatorAcceptedAt: { not: null } },
      },
      select: {
        id: true,
        sequence: true,
        amountMinor: true,
        condition: true,
        releasedAt: true,
      },
      orderBy: { sequence: 'asc' },
    });

    return milestones.map((milestone) => ({
      id: milestone.id,
      sequence: milestone.sequence,
      amountMinor: milestone.amountMinor,
      releasedAt: milestone.releasedAt,
      condition: milestone.condition as unknown as MilestoneCondition,
    }));
  }

  private async loadSubmission(submissionId: string, organizationId: string) {
    const submission = await this.prisma.submission.findFirst({
      // The tenant predicate is in the WHERE clause, so another org's submission
      // simply does not exist here.
      where: { id: submissionId, deliverable: { deal: { organizationId } } },
      select: {
        id: true,
        version: true,
        deliverable: { select: { id: true, dealId: true, state: true, version: true } },
      },
    });

    if (!submission) throw new NotFoundException('No such submission.');
    return submission;
  }
}
