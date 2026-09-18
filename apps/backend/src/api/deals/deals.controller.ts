import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type DealDetailSchema,
  type DealDraftSchema,
  type DealSummarySchema,
  type MilestoneConditionSchema,
  type OfferDealBodySchema,
  type TerminateDealBodySchema,
  getDeal as getDealOperation,
  listDeals as listDealsOperation,
} from '@rayi/contracts';
import type { MilestoneCondition } from '@rayi/domain';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { money } from '@/common/money/money.dto';
import type { RequestContext } from '@/common/types/request-context.type';
import {
  ValidatedBody,
  ValidatedParams,
  ValidatedQuery,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import type { DealDraft } from './deals.service';
import { DealsService } from './deals.service';

type OrgParams = z.infer<NonNullable<typeof listDealsOperation.pathParams>>;
type DealParams = z.infer<NonNullable<typeof getDealOperation.pathParams>>;
type DealsQuery = z.infer<NonNullable<typeof listDealsOperation.query>>;
type SummaryDto = z.infer<typeof DealSummarySchema>;
type DetailDto = z.infer<typeof DealDetailSchema>;
type DraftBody = z.infer<typeof DealDraftSchema>;
type OfferBody = z.infer<typeof OfferDealBodySchema>;
type TerminateBody = z.infer<typeof TerminateDealBodySchema>;
type ConditionDto = z.infer<typeof MilestoneConditionSchema>;

@ApiTags('deals')
@Controller()
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Operation('listDeals')
  async list(
    @ValidatedParams() params: OrgParams,
    @ValidatedQuery() query: DealsQuery | undefined,
  ): Promise<{
    deals: SummaryDto[];
    totals: { committed: ReturnType<typeof money>; released: ReturnType<typeof money> };
  }> {
    const result = await this.deals.list(params.orgId, {
      ...(query?.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query?.state ? { state: query.state } : {}),
      ...(query?.creatorId ? { creatorId: query.creatorId } : {}),
    });

    return {
      deals: result.deals.map((deal) => ({
        dealId: deal.dealId,
        campaignId: deal.campaignId,
        campaignName: deal.campaignName,
        creatorId: deal.creatorId,
        creatorHandle: deal.creatorHandle,
        state: deal.state as SummaryDto['state'],
        total: money(deal.totalMinor, deal.currency),
        released: money(deal.releasedMinor, deal.currency),
        deliverablesTotal: deal.deliverablesTotal,
        deliverablesApproved: deal.deliverablesApproved,
        createdAt: deal.createdAt.toISOString(),
        acceptedAt: deal.acceptedAt?.toISOString() ?? null,
      })),
      totals: {
        committed: money(result.committedMinor, result.currency),
        released: money(result.releasedMinor, result.currency),
      },
    };
  }

  @Operation('getDeal')
  async get(@ValidatedParams() params: DealParams): Promise<DetailDto> {
    return this.toDetailDto(await this.deals.get(params.orgId, params.dealId));
  }

  @Operation('previewDeal')
  async preview(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: DraftBody,
  ): Promise<{
    milestones: Array<{
      title: string;
      amount: ReturnType<typeof money>;
      percentageBps: number | null;
      condition: ConditionDto;
      satisfiableAtStart: boolean;
      reason: string;
    }>;
    milestoneTotal: ReturnType<typeof money>;
    total: ReturnType<typeof money>;
    balances: boolean;
    advanceTotal: ReturnType<typeof money>;
    problems: string[];
  }> {
    // Pure and side-effect free: creates nothing, moves nothing, and runs the
    // SAME functions the real creation path freezes.
    const preview = this.deals.preview(this.toDraft(body));
    return {
      milestones: preview.milestones.map((milestone) => ({
        title: milestone.title,
        amount: money(milestone.amountMinor, preview.currency),
        percentageBps: milestone.percentageBps,
        condition: milestone.condition as ConditionDto,
        satisfiableAtStart: milestone.satisfiableAtStart,
        reason: milestone.reason,
      })),
      milestoneTotal: money(preview.milestoneTotalMinor, preview.currency),
      total: money(preview.totalMinor, preview.currency),
      balances: preview.balances,
      advanceTotal: money(preview.advanceTotalMinor, preview.currency),
      problems: preview.problems,
    };
  }

  @Operation('createDeal')
  async create(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: DraftBody,
    @Req() request: FastifyRequest,
  ): Promise<DetailDto> {
    const deal = await this.deals.create(
      params.orgId,
      this.toDraft(body),
      this.caller(request),
      this.context(request),
    );
    return this.toDetailDto(deal);
  }

  @Operation('offerDeal')
  async offer(
    @ValidatedParams() params: DealParams,
    @ValidatedBody() body: OfferBody,
    @Req() request: FastifyRequest,
  ): Promise<{ dealId: string; state: SummaryDto['state']; offeredAt: string }> {
    const result = await this.deals.offer(
      params.orgId,
      params.dealId,
      {
        // Parsed once, here. The server compares it against its OWN figure and
        // refuses on mismatch — no number from a client becomes a number paid.
        acknowledgedAdvanceMinor: BigInt(body.acknowledgedAdvanceMinor),
        code: body.code,
      },
      this.caller(request),
      this.context(request),
    );
    return {
      dealId: result.dealId,
      state: result.state,
      offeredAt: result.offeredAt.toISOString(),
    };
  }

  @Operation('terminateDeal')
  async terminate(
    @ValidatedParams() params: DealParams,
    @ValidatedBody() body: TerminateBody,
    @Req() request: FastifyRequest,
  ): Promise<{
    dealId: string;
    state: SummaryDto['state'];
    returned: ReturnType<typeof money>;
  }> {
    const result = await this.deals.terminate(
      params.orgId,
      params.dealId,
      body,
      this.caller(request),
      this.context(request),
    );
    return {
      dealId: result.dealId,
      state: result.state,
      returned: money(result.returnedMinor, result.currency),
    };
  }

  private toDraft(body: DraftBody): DealDraft {
    return {
      campaignId: body.campaignId,
      creatorHandle: body.creatorHandle,
      totalMinor: BigInt(body.total.amountMinor),
      currency: body.total.currency,
      deliverables: body.deliverables.map((deliverable) => ({
        slot: deliverable.slot,
        brief: deliverable.brief,
        dueAt: deliverable.dueAt ? new Date(deliverable.dueAt) : null,
      })),
      milestones: body.milestones.map((milestone) => ({
        title: milestone.title,
        amountMinor: milestone.amount ? BigInt(milestone.amount.amountMinor) : undefined,
        percentageBps: milestone.percentageBps,
        condition: milestone.condition as unknown as MilestoneCondition,
      })),
    };
  }

  private toDetailDto(deal: Awaited<ReturnType<DealsService['get']>>): DetailDto {
    return {
      dealId: deal.dealId,
      campaignId: deal.campaignId,
      campaignName: deal.campaignName,
      creatorId: deal.creatorId,
      creatorHandle: deal.creatorHandle,
      state: deal.state as DetailDto['state'],
      total: money(deal.totalMinor, deal.currency),
      released: money(deal.releasedMinor, deal.currency),
      deliverablesTotal: deal.deliverablesTotal,
      deliverablesApproved: deal.deliverablesApproved,
      createdAt: deal.createdAt.toISOString(),
      acceptedAt: deal.acceptedAt?.toISOString() ?? null,
      milestones: deal.milestones.map((milestone) => ({
        milestoneId: milestone.milestoneId,
        title: milestone.title,
        amount: money(milestone.amountMinor, deal.currency),
        percentageBps: milestone.percentageBps,
        condition: milestone.condition as ConditionDto,
        satisfied: milestone.satisfied,
        reason: milestone.reason,
        releasedAt: milestone.releasedAt?.toISOString() ?? null,
        satisfiableAtStart: milestone.satisfiableAtStart,
      })),
      deliverables: deal.deliverables.map((deliverable) => ({
        deliverableId: deliverable.deliverableId,
        slot: deliverable.slot,
        brief: deliverable.brief,
        state: deliverable.state as DetailDto['deliverables'][number]['state'],
        latestVersion: deliverable.latestVersion,
        dueAt: deliverable.dueAt?.toISOString() ?? null,
      })),
      agreementVersions: deal.agreementVersions.map((agreement) => ({
        version: agreement.version,
        createdAt: agreement.createdAt.toISOString(),
        acceptedAt: agreement.acceptedAt?.toISOString() ?? null,
        total: money(agreement.totalMinor, deal.currency),
      })),
    };
  }

  private caller(request: FastifyRequest): string {
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException('Sign in to continue.');
    return userId;
  }

  private context(request: FastifyRequest): RequestContext {
    return {
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}
