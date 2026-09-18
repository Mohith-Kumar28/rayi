import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { assertCurrency, exponentOf, type Currency } from '@rayi/domain';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  type CreatorDealSchema,
  type CreatorEarningsSchema,
  type SubmitDeliverableBodySchema,
  getMyDeal as getMyDealOperation,
  submitDeliverable as submitOperation,
} from '@rayi/contracts';

import type { RequestContext } from '@/common/types/request-context.type';
import { ValidatedBody, ValidatedParams } from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { CreatorService, type CreatorDealView, type CreatorMilestoneView } from './creator.service';

/**
 * The creator surface.
 *
 * Every route is `access: { kind: 'self' }` and carries NO `{orgId}` — a creator
 * is not a member of the brand's organization, and modelling them as one would
 * give them a role in a tenant whose money they can see part of.
 *
 * There is deliberately no creator id parameter anywhere in this file. The
 * session is the only thing that says who the caller is.
 */

type DealDto = z.infer<typeof CreatorDealSchema>;
type EarningsDto = z.infer<typeof CreatorEarningsSchema>;
type SubmitBody = z.infer<typeof SubmitDeliverableBodySchema>;
type DealParams = z.infer<NonNullable<typeof getMyDealOperation.pathParams>>;
type SubmitParams = z.infer<NonNullable<typeof submitOperation.pathParams>>;

@ApiTags('creator')
@Controller()
export class CreatorController {
  constructor(private readonly creator: CreatorService) {}

  @Operation('listMyDeals')
  async listDeals(@Req() request: FastifyRequest): Promise<{ deals: DealDto[] }> {
    const deals = await this.creator.listDeals(this.caller(request));
    return { deals: deals.map((deal) => toDealDto(deal)) };
  }

  @Operation('getMyDeal')
  async getDeal(
    @ValidatedParams() params: DealParams,
    @Req() request: FastifyRequest,
  ): Promise<DealDto> {
    return toDealDto(await this.creator.getDeal(params.dealId, this.caller(request)));
  }

  @Operation('submitDeliverable')
  async submit(
    @ValidatedParams() params: SubmitParams,
    @ValidatedBody() body: SubmitBody,
    @Req() request: FastifyRequest,
  ): Promise<{ submissionId: string; version: number }> {
    return this.creator.submit({
      deliverableId: params.deliverableId,
      creatorUserId: this.caller(request),
      assetKey: body.assetKey,
      ...(body.caption !== undefined ? { caption: body.caption } : {}),
      context: this.context(request),
    });
  }

  @Operation('getMyEarnings')
  async earnings(@Req() request: FastifyRequest): Promise<EarningsDto> {
    const earnings = await this.creator.earnings(this.caller(request));
    const currency = assertCurrency(earnings.currency);
    const exponent = exponentOf(currency);

    return {
      paidOut: money(earnings.paidOutMinor, currency, exponent),
      awaitingPayout: money(earnings.awaitingPayoutMinor, currency, exponent),
      agreedNotYetUnlocked: money(earnings.agreedNotYetUnlockedMinor, currency, exponent),
    };
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
  currency: Currency;
  exponent: number;
}

function money(amountMinor: bigint, currency: Currency, exponent: number): MoneyDto {
  return { amountMinor: amountMinor.toString(), currency, exponent };
}

function toMilestoneDto(
  milestone: CreatorMilestoneView,
  currency: Currency,
  exponent: number,
): DealDto['milestones'][number] {
  return {
    milestoneId: milestone.milestoneId,
    title: milestone.title,
    amount: money(milestone.amountMinor, currency, exponent),
    satisfied: milestone.satisfied,
    reason: milestone.reason,
    releasedAt: milestone.releasedAt?.toISOString() ?? null,
  };
}

function toDealDto(deal: CreatorDealView): DealDto {
  const currency = assertCurrency(deal.currency);
  const exponent = exponentOf(currency);

  return {
    dealId: deal.dealId,
    brandName: deal.brandName,
    campaignName: deal.campaignName,
    state: deal.state as DealDto['state'],
    total: money(deal.totalMinor, currency, exponent),
    earned: money(deal.earnedMinor, currency, exponent),
    milestones: deal.milestones.map((milestone) => toMilestoneDto(milestone, currency, exponent)),
    deliverables: deal.deliverables.map((row) => ({
      deliverableId: row.deliverableId,
      slot: row.slot,
      state: row.state as DealDto['deliverables'][number]['state'],
      brief: row.brief,
      latestVersion: row.latestVersion,
      latestComment: row.latestComment,
    })),
    nextUnlock: deal.nextUnlock ? toMilestoneDto(deal.nextUnlock, currency, exponent) : null,
  };
}
