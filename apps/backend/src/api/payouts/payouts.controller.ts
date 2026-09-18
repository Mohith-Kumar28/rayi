import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreatorProfileSchema,
  type PayoutDestinationSchema,
  type PayoutSchema,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { money } from '@/common/money/money.dto';
import type { RequestContext } from '@/common/types/request-context.type';
import { ValidatedBody } from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { PayoutsService } from './payouts.service';

/**
 * The creator's money.
 *
 * Every route is `access: { kind: 'self' }` and carries NO organization — a
 * creator is not a member of the brand's organization, and authorising these
 * against one would mean authorising against something unrelated to what they
 * touch. The handler scopes by the session user id in the WHERE clause; the
 * guard only says you are signed in.
 */

type PayoutDto = z.infer<typeof PayoutSchema>;
type DestinationDto = z.infer<typeof PayoutDestinationSchema>;
type ProfileDto = z.infer<typeof CreatorProfileSchema>;

@ApiTags('payouts')
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Operation('getMyPayouts')
  async list(@Req() request: FastifyRequest): Promise<{
    payouts: PayoutDto[];
    awaitingNextRun: ReturnType<typeof money>;
    nextRunAt: string | null;
  }> {
    const result = await this.payouts.listMine(this.caller(request));
    return {
      payouts: result.payouts.map((payout) => ({
        payoutId: payout.id,
        amount: money(payout.amountMinor, payout.currency),
        state: payout.state as PayoutDto['state'],
        batchId: payout.batchId,
        expectedArrivalAt: payout.expectedArrivalAt?.toISOString() ?? null,
        paidAt: payout.paidAt?.toISOString() ?? null,
        reason: payout.reason,
        sources: payout.sources.map((source) => ({
          dealId: source.dealId,
          brandName: source.brandName,
          milestoneTitle: source.milestoneTitle,
          amount: money(source.amountMinor, payout.currency),
        })),
      })),
      awaitingNextRun: money(result.awaitingMinor, result.currency),
      nextRunAt: result.nextRunAt?.toISOString() ?? null,
    };
  }

  @Operation('getMyPayoutDestination')
  async destination(@Req() request: FastifyRequest): Promise<DestinationDto> {
    const destination = await this.payouts.destination(this.caller(request));
    return {
      last4: destination.last4,
      bankName: destination.bankName,
      payoutsEnabled: destination.payoutsEnabled,
      pendingRequirements: destination.pendingRequirements,
      holdUntil: destination.holdUntil?.toISOString() ?? null,
      lastChangedAt: destination.lastChangedAt?.toISOString() ?? null,
    };
  }

  @Operation('startPayoutDestinationChange')
  async startChange(
    @ValidatedBody() body: { code: string },
    @Req() request: FastifyRequest,
  ): Promise<{ onboardingUrl: string; expiresAt: string; holdHours: number }> {
    const result = await this.payouts.startDestinationChange(
      this.caller(request),
      body.code,
      this.context(request),
      /*
       * Null until Connect onboarding is wired, and the service REFUSES rather
       * than returning a link that goes nowhere.
       *
       * Wiring it is deliberately NOT a config key. Minting an AccountLink is a
       * money-moving action against the connected account, and the api process
       * holds only a restricted key that cannot create transfers — so it must
       * enqueue a treasury command and let the WORKER mint the link, exactly
       * like every other Stripe call. A config value here would look like the
       * feature was one environment variable away from working, which it is not.
       */
      null,
    );
    return {
      onboardingUrl: result.onboardingUrl,
      expiresAt: result.expiresAt.toISOString(),
      holdHours: result.holdHours,
    };
  }

  @Operation('getMyCreatorProfile')
  async profile(@Req() request: FastifyRequest): Promise<ProfileDto> {
    return this.payouts.profile(this.caller(request));
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
