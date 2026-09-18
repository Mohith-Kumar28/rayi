import { Controller, ForbiddenException, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  type ApprovalResultSchema,
  type ApproveBodySchema,
  type QueueRowSchema,
  approveSubmission as approveOperation,
  listReviewQueue as listReviewQueueOperation,
  undoApproval as undoApprovalOperation,
} from '@rayi/contracts';

import type { RequestContext } from '@/common/types/request-context.type';
import { assertCurrency, exponentOf, type Currency } from '@rayi/domain';
import {
  ValidatedBody,
  ValidatedParams,
  ValidatedQuery,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { ReviewQueueService } from './review-queue.service';
import { ReviewService } from './review.service';

/**
 * The review surface.
 *
 * `approveSubmission` is declared `movesMoney: true` even though it writes no
 * ledger entry, because it deterministically releases funds thirty seconds
 * later. A route that moves money on a timer is still a route that moves money,
 * and the guard's money-authority ceiling applies to it.
 */

type QueueRowDto = z.infer<typeof QueueRowSchema>;
type ApproveBody = z.infer<typeof ApproveBodySchema>;
type ApprovalResultDto = z.infer<typeof ApprovalResultSchema>;
type QueueParams = z.infer<NonNullable<typeof listReviewQueueOperation.pathParams>>;
type QueueQuery = z.infer<NonNullable<typeof listReviewQueueOperation.query>>;
type ApproveParams = z.infer<NonNullable<typeof approveOperation.pathParams>>;
type UndoParams = z.infer<NonNullable<typeof undoApprovalOperation.pathParams>>;

@ApiTags('review')
@Controller()
export class ReviewController {
  constructor(
    private readonly queue: ReviewQueueService,
    private readonly reviews: ReviewService,
  ) {}

  @Operation('listReviewQueue')
  async list(
    @ValidatedParams() params: QueueParams,
    @ValidatedQuery() query: QueueQuery,
  ): Promise<{
    exceptions: QueueRowDto[];
    cleared: { count: number; submissionIds: string[]; releasesTotal: MoneyDto };
  }> {
    const queue = await this.queue.build(params.orgId, query?.campaignId);
    // Narrowed once, here. An unknown currency fails at the boundary rather than
    // reaching a client that would format it with a guessed exponent.
    const currency = assertCurrency(queue.currency);
    const exponent = exponentOf(currency);

    return {
      exceptions: queue.exceptions.map((row) => ({
        submissionId: row.submissionId,
        deliverableId: row.deliverableId,
        dealId: row.dealId,
        campaignName: row.campaignName,
        creatorHandle: row.creatorHandle,
        slot: row.slot,
        submissionVersion: row.submissionVersion,
        submittedAt: row.submittedAt.toISOString(),
        caption: row.caption,
        previewUrl: row.previewUrl,
        checks: row.checks.map((check) => ({ ...check })),
        // Null rather than a zero amount when nothing is released. A "$0.00"
        // badge on a routine row is noise on the screen whose whole job is
        // making the money rows stand out.
        releasesOnApproval:
          row.releasesMinor > 0n
            ? money(row.releasesMinor, currency, exponent)
            : null,
      })),
      cleared: {
        count: queue.cleared.count,
        submissionIds: [...queue.cleared.submissionIds],
        releasesTotal: money(queue.cleared.releasesTotalMinor, currency, exponent),
      },
    };
  }

  @Operation('approveSubmission')
  async approve(
    @ValidatedParams() params: ApproveParams,
    @ValidatedBody() body: ApproveBody,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalResultDto> {
    const actorUserId = this.caller(request);

    const outcome = await this.reviews.approve({
      submissionId: params.submissionId,
      organizationId: params.orgId,
      actorUserId,
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
      ...(body.voiceKey !== undefined ? { voiceKey: body.voiceKey } : {}),
      context: this.context(request),
    });

    // The client's ASSERTION about what it believed it was approving, compared
    // against what the server computed. A stale queue must not approve an amount
    // the reviewer never saw — and the server pays ITS number either way, so the
    // only possible outcome of a mismatch is a refusal.
    if (body.expectedReleaseMinor !== undefined) {
      const expected = BigInt(body.expectedReleaseMinor);
      if (expected !== outcome.totalToReleaseMinor) {
        throw new ForbiddenException(
          'This row has changed since you last loaded the queue. Reload and look again.',
        );
      }
    }

    const currency = 'USD' as const;
    return {
      reviewId: outcome.reviewId,
      deliverableId: outcome.deliverableId,
      satisfiedMilestoneIds: [...outcome.satisfiedMilestoneIds],
      releases: money(outcome.totalToReleaseMinor, currency, exponentOf(currency)),
      releasesAt: outcome.releasesAt.toISOString(),
    };
  }

  @Operation('requestChanges')
  async requestChanges(
    @ValidatedParams() params: ApproveParams,
    @ValidatedBody() body: { comment: string; voiceKey?: string },
    @Req() request: FastifyRequest,
  ): Promise<{ reviewId: string }> {
    return this.reviews.requestChanges({
      submissionId: params.submissionId,
      organizationId: params.orgId,
      actorUserId: this.caller(request),
      comment: body.comment,
      ...(body.voiceKey !== undefined ? { voiceKey: body.voiceKey } : {}),
      context: this.context(request),
    });
  }

  @Operation('undoApproval')
  async undo(
    @ValidatedParams() params: UndoParams,
    @Req() request: FastifyRequest,
  ): Promise<{ undone: boolean }> {
    await this.reviews.undoApproval({
      reviewId: params.reviewId,
      organizationId: params.orgId,
      actorUserId: this.caller(request),
      context: this.context(request),
    });
    return { undone: true };
  }

  private caller(request: FastifyRequest): string {
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException('Sign in to continue.');
    return userId;
  }

  private context(request: FastifyRequest): RequestContext {
    return {
      requestId: request.id ? String(request.id) : undefined,
      ipAddress: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 500)
          : undefined,
    };
  }
}

interface MoneyDto {
  amountMinor: string;
  /**
   * NARROWED, not a bare string.
   *
   * `assertCurrency` throws on anything the system does not know, so an
   * unrecognised currency fails loudly here rather than reaching a client that
   * would format it with a guessed exponent.
   */
  currency: Currency;
  exponent: number;
}

/**
 * The wire shape.
 *
 * A STRING of integer minor units with a SERVER-SUPPLIED exponent. Never a JSON
 * number — precision past 2^53 is reachable, and a codebase where a number is
 * *sometimes* fine is one where someone eventually uses it where it is not.
 */
function money(amountMinor: bigint, currency: string, exponent: number): MoneyDto {
  return { amountMinor: amountMinor.toString(), currency: assertCurrency(currency), exponent };
}
