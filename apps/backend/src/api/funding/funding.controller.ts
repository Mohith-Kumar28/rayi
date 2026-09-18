import { Controller, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AllocateBudgetBodySchema,
  type AllocateBudgetResponseSchema,
  allocateBudget as allocateBudgetOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { UnauthorizedException } from '@nestjs/common';

import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';
import { AllocateBudgetUseCase } from '@/treasury/use-cases/allocate-budget.use-case';

/**
 * The public funding surface.
 *
 * Note what this controller is NOT allowed to reach. It imports a use case that
 * records an intent; it has no ledger repository, no Stripe client and no
 * account id anywhere in scope. The money work happens in a process this file
 * cannot call — an RCE here yields a row in `treasury_command` and nothing more,
 * and even that row is re-authorised before it becomes money.
 *
 * The route, method, status code and required permission all come from the
 * single `allocateBudget` manifest entry. There is no `@Post('...')` here to
 * drift from the published spec.
 */

type AllocateBudgetBody = z.infer<typeof AllocateBudgetBodySchema>;
type AllocateBudgetParams = z.infer<
  NonNullable<typeof allocateBudgetOperation.pathParams>
>;
type AllocateBudgetResponse = z.infer<typeof AllocateBudgetResponseSchema>;

/**
 * `@Controller()` with no path. The manifest holds the whole path, so there is
 * exactly one place to read to know what a URL maps to — a controller prefix
 * would put half the answer here and half there.
 */
@ApiTags('funding')
@Controller()
export class FundingController {
  constructor(private readonly allocateBudget: AllocateBudgetUseCase) {}

  @Operation('allocateBudget')
  async allocate(
    @ValidatedParams() params: AllocateBudgetParams,
    @ValidatedBody() body: AllocateBudgetBody,
    @Req() request: FastifyRequest,
  ): Promise<AllocateBudgetResponse> {
    const session = (
      request as FastifyRequest & { session?: { user?: { id?: string } } }
    ).session;
    const actorUserId = session?.user?.id;
    if (!actorUserId) throw new UnauthorizedException('Sign in to continue.');

    const result = await this.allocateBudget.execute({
      organizationId: params.orgId,
      campaignId: params.campaignId,
      // Past the contract boundary the only money type is bigint. The wire
      // carries a string of integer minor units, and the manifest's regex has
      // already rejected '', '15000.00' and '1e5' — each of which BigInt()
      // handles differently and none of them correctly: BigInt('') is 0n, which
      // would render a confident $0.00 and allocate nothing.
      amountMinor: BigInt(body.amount.amountMinor),
      currency: body.amount.currency,
      idempotencyKey: body.idempotencyKey,
      actorUserId,
      ...(request.id ? { requestId: String(request.id) } : {}),
      ...(body.expectedAvailableMinor
        ? { expectedAvailableMinor: BigInt(body.expectedAvailableMinor) }
        : {}),
    });

    // 202 Accepted, set from the manifest. The response deliberately carries no
    // balance: the allocation has not happened yet, and returning a figure here
    // would be the UI asserting a fact about money that may not be true.
    return {
      commandId: result.commandId,
      status: result.status,
      campaignId: result.campaignId,
    };
  }
}
