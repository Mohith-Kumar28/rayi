import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CampaignDetailSchema,
  type CreateCampaignBodySchema,
  type UpdateCampaignBodySchema,
  getCampaign as getCampaignOperation,
  createCampaign as createCampaignOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { money } from '@/common/money/money.dto';
import type { RequestContext } from '@/common/types/request-context.type';
import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { CampaignsService } from './campaigns.service';

type OrgParams = z.infer<NonNullable<typeof createCampaignOperation.pathParams>>;
type CampaignParams = z.infer<NonNullable<typeof getCampaignOperation.pathParams>>;
type CampaignDto = z.infer<typeof CampaignDetailSchema>;
type CreateBody = z.infer<typeof CreateCampaignBodySchema>;
type UpdateBody = z.infer<typeof UpdateCampaignBodySchema>;

@ApiTags('campaigns')
@Controller()
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Operation('createCampaign')
  async create(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: CreateBody,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDto> {
    const campaign = await this.campaigns.create(
      params.orgId,
      {
        workspaceId: body.workspaceId,
        name: body.name,
        brief: body.brief,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
      },
      this.caller(request),
      this.context(request),
    );
    return this.toDto(campaign);
  }

  @Operation('getCampaign')
  async get(@ValidatedParams() params: CampaignParams): Promise<CampaignDto> {
    return this.toDto(await this.campaigns.get(params.orgId, params.campaignId));
  }

  @Operation('updateCampaign')
  async update(
    @ValidatedParams() params: CampaignParams,
    @ValidatedBody() body: UpdateBody,
    @Req() request: FastifyRequest,
  ): Promise<CampaignDto> {
    const campaign = await this.campaigns.update(
      params.orgId,
      params.campaignId,
      {
        name: body.name,
        brief: body.brief,
        endsAt: body.endsAt === undefined ? undefined : body.endsAt ? new Date(body.endsAt) : null,
        state: body.state,
      },
      this.caller(request),
      this.context(request),
    );
    return this.toDto(campaign);
  }

  private toDto(campaign: Awaited<ReturnType<CampaignsService['get']>>): CampaignDto {
    /*
     * `allocated` is a LEDGER figure and this process cannot read the ledger.
     *
     * It is reported as the committed total rather than invented or defaulted to
     * a number that looks authoritative: what a campaign has committed to deals
     * is a fact this process legitimately knows, and it is the figure a brand
     * needs beside released. The true allocation comes from the funding
     * surface, which the worker feeds.
     */
    const allocatedMinor = campaign.committedMinor;
    return {
      campaignId: campaign.campaignId,
      workspaceId: campaign.workspaceId,
      workspaceName: campaign.workspaceName,
      name: campaign.name,
      brief: campaign.brief,
      state: campaign.state as CampaignDto['state'],
      startsAt: campaign.startsAt?.toISOString() ?? null,
      endsAt: campaign.endsAt?.toISOString() ?? null,
      createdAt: campaign.createdAt.toISOString(),
      allocated: money(allocatedMinor, campaign.currency),
      committed: money(campaign.committedMinor, campaign.currency),
      released: money(campaign.releasedMinor, campaign.currency),
      // Server-computed, never subtracted in a browser, and floored at zero so
      // an over-committed campaign never renders as money available.
      uncommitted: money(
        allocatedMinor > campaign.committedMinor ? allocatedMinor - campaign.committedMinor : 0n,
        campaign.currency,
      ),
      dealCount: campaign.dealCount,
      deliverablesTotal: campaign.deliverablesTotal,
      deliverablesApproved: campaign.deliverablesApproved,
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
