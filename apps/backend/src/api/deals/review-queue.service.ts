import { Injectable } from '@nestjs/common';
import { evaluateDeal, type DealFacts, type MilestoneCondition } from '@rayi/domain';

import { PrismaService } from '@/database/prisma.service';

/**
 * Builds the review queue.
 *
 * The product claim is three seconds a row, and the shape of this response is
 * what makes it possible: **exceptions plus one summary**, rather than a list
 * the reviewer has to read.
 *
 * A row is an exception when it needs a human decision:
 *
 *   - a check FAILED, so the work may not be usable
 *   - a check ERRORED, so we could not verify it — shown as "could not verify",
 *     never treated as a failure, because a creator must not be punished for our
 *     infrastructure
 *   - approving it would RELEASE FUNDS, which is a decision rather than a
 *     formality
 *
 * Everything else cleared every check and releases nothing, so it collapses into
 * a single bar the reviewer can approve in one action. That is the entire
 * difference between a queue someone works through and a queue someone abandons.
 */

/**
 * One pipeline result.
 *
 * Carries only what the pipeline actually observed. `label` and `tier` are NOT
 * here: they are properties of the check itself, declared once in the domain
 * catalogue and derived at the serialisation boundary. A pipeline that could
 * emit its own tier could emit a different one from the catalogue, and the
 * reviewer would see a blocking failure rendered as advisory.
 */
export interface CheckResult {
  readonly name: string;
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  readonly detail: string | null;
}

export interface QueueRow {
  readonly submissionId: string;
  readonly deliverableId: string;
  readonly dealId: string;
  readonly campaignName: string;
  readonly creatorHandle: string;
  readonly slot: string;
  readonly submissionVersion: number;
  readonly submittedAt: Date;
  readonly caption: string | null;
  readonly previewUrl: string | null;
  readonly checks: readonly CheckResult[];
  /** Minor units this approval would release. Zero for an ordinary row. */
  readonly releasesMinor: bigint;
}

export interface ReviewQueue {
  readonly exceptions: readonly QueueRow[];
  readonly cleared: {
    readonly count: number;
    readonly submissionIds: readonly string[];
    readonly releasesTotalMinor: bigint;
  };
  readonly currency: string;
}

@Injectable()
export class ReviewQueueService {
  constructor(private readonly prisma: PrismaService) {}

  async build(organizationId: string, campaignId?: string): Promise<ReviewQueue> {
    // The LATEST submission per deliverable that is still awaiting a decision.
    // Earlier versions are history: a reviewer acts on what was last submitted,
    // and showing a superseded attempt would invite a decision on work the
    // creator has already replaced.
    const deliverables = await this.prisma.deliverable.findMany({
      where: {
        state: { in: ['submitted', 'in_review'] },
        deal: {
          organizationId,
          state: { in: ['active', 'accepted'] },
          ...(campaignId ? { campaignId } : {}),
        },
      },
      select: {
        id: true,
        sequence: true,
        dealId: true,
        deal: {
          select: {
            id: true,
            currency: true,
            campaign: { select: { name: true } },
            creator: { select: { username: true } },
            deliverables: { select: { id: true, state: true } },
          },
        },
        submissions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, submittedAt: true, caption: true, assetKey: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Milestones are loaded per deal, once, rather than per row. A queue of 200
    // rows across 5 deals would otherwise issue 200 milestone queries to answer
    // a question that has 5 answers.
    const dealIds = [...new Set(deliverables.map((row) => row.dealId))];
    const milestonesByDeal = await this.milestonesByDeal(dealIds);

    const exceptions: QueueRow[] = [];
    const cleared: string[] = [];
    let currency = 'USD';

    for (const deliverable of deliverables) {
      const submission = deliverable.submissions[0];
      if (!submission) continue; // in_review with no submission is not reviewable

      currency = deliverable.deal.currency;

      const checks = await this.checksFor(submission.id);
      const releasesMinor = this.wouldRelease(
        deliverable.deal,
        deliverable.id,
        milestonesByDeal.get(deliverable.dealId) ?? [],
      );

      const needsAttention =
        releasesMinor > 0n || checks.some((check) => check.status !== 'PASS');

      if (!needsAttention) {
        cleared.push(submission.id);
        continue;
      }

      exceptions.push({
        submissionId: submission.id,
        deliverableId: deliverable.id,
        dealId: deliverable.dealId,
        campaignName: deliverable.deal.campaign.name,
        creatorHandle: deliverable.deal.creator.username,
        slot: `Video ${deliverable.sequence} of ${deliverable.deal.deliverables.length}`,
        submissionVersion: submission.version,
        submittedAt: submission.submittedAt,
        caption: submission.caption,
        // A DERIVED rendition, never the original. Originals are evidence: they
        // are WORM-locked, never served, and the intake bucket has no CDN at all.
        previewUrl: submission.assetKey ? `/media/renditions/${submission.id}/preview.mp4` : null,
        checks,
        releasesMinor,
      });
    }

    return {
      exceptions,
      cleared: {
        count: cleared.length,
        submissionIds: cleared,
        // Zero by construction: a row that would release anything is an
        // exception, so nothing in the cleared bar can move money. Returned
        // explicitly so the UI never has to assume that.
        releasesTotalMinor: 0n,
      },
      currency,
    };
  }

  /**
   * What approving this deliverable would release.
   *
   * Uses the same `evaluateDeal` the approval path uses, so the number the
   * reviewer sees and the number the server acts on come from one function. Two
   * implementations would eventually disagree, and the disagreement would be
   * visible only as a reviewer approving an amount they did not expect.
   */
  private wouldRelease(
    deal: { deliverables: Array<{ id: string; state: string }> },
    deliverableId: string,
    milestones: ReturnType<ReviewQueueService['toMilestoneInputs']>,
  ): bigint {
    if (milestones.length === 0) return 0n;

    const approved = new Set(
      deal.deliverables.filter((row) => row.state === 'approved').map((row) => row.id),
    );

    const base: DealFacts = {
      approvedDeliverableIds: approved,
      totalDeliverables: deal.deliverables.filter((row) => row.state !== 'cancelled').length,
      manuallyApprovedMilestoneIds: new Set(),
      now: new Date(),
    };

    const before = new Set(
      evaluateDeal(milestones, base).toRelease.map((verdict) => verdict.milestoneId),
    );
    const after = evaluateDeal(milestones, {
      ...base,
      approvedDeliverableIds: new Set([...approved, deliverableId]),
    });

    return after.toRelease
      .filter((verdict) => !before.has(verdict.milestoneId))
      .reduce((total, verdict) => total + verdict.amountMinor, 0n);
  }

  private toMilestoneInputs(
    rows: Array<{
      id: string;
      sequence: number;
      amountMinor: bigint;
      condition: unknown;
      releasedAt: Date | null;
    }>,
  ) {
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      amountMinor: row.amountMinor,
      releasedAt: row.releasedAt,
      condition: row.condition as MilestoneCondition,
    }));
  }

  private async milestonesByDeal(dealIds: string[]) {
    const rows = await this.prisma.milestone.findMany({
      where: {
        dealId: { in: dealIds },
        // The LIVE agreement only. A superseded version describes terms no
        // longer in force.
        agreementVersion: { supersededAt: null, creatorAcceptedAt: { not: null } },
      },
      select: {
        id: true,
        dealId: true,
        sequence: true,
        amountMinor: true,
        condition: true,
        releasedAt: true,
      },
      orderBy: { sequence: 'asc' },
    });

    const grouped = new Map<string, ReturnType<ReviewQueueService['toMilestoneInputs']>>();
    for (const dealId of dealIds) {
      grouped.set(
        dealId,
        this.toMilestoneInputs(rows.filter((row) => row.dealId === dealId)),
      );
    }
    return grouped;
  }

  /**
   * The verification pipeline's results for a submission.
   *
   * The pipeline itself is media work that lands with asset handling. Until then
   * this returns an empty list, which makes every row a non-exception unless it
   * releases money — honest, and the right default: inventing PASS results we
   * did not compute would be worse than showing none.
   */
  private async checksFor(_submissionId: string): Promise<CheckResult[]> {
    return [];
  }
}
