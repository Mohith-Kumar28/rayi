import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type RosterCreatorDetailSchema,
  type RosterCreatorSchema,
  getRosterCreator as getRosterCreatorOperation,
  listRoster as listRosterOperation,
} from '@rayi/contracts';
import type { z } from 'zod';

import { money } from '@/common/money/money.dto';
import {
  ValidatedParams,
  ValidatedQuery,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { RosterService } from './roster.service';

type OrgParams = z.infer<NonNullable<typeof listRosterOperation.pathParams>>;
type CreatorParams = z.infer<NonNullable<typeof getRosterCreatorOperation.pathParams>>;
type RosterQuery = z.infer<NonNullable<typeof listRosterOperation.query>>;
type CreatorDto = z.infer<typeof RosterCreatorSchema>;
type CreatorDetailDto = z.infer<typeof RosterCreatorDetailSchema>;

@ApiTags('roster')
@Controller()
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @Operation('listRoster')
  async list(
    @ValidatedParams() params: OrgParams,
    @ValidatedQuery() query: RosterQuery | undefined,
  ): Promise<{ creators: CreatorDto[]; totals: { creatorCount: number; released: ReturnType<typeof money> } }> {
    const roster = await this.roster.list(params.orgId, {
      ...(query?.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query?.search ? { search: query.search } : {}),
    });

    return {
      creators: roster.creators.map((creator) => this.toDto(creator, roster.currency)),
      totals: {
        creatorCount: roster.creators.length,
        released: money(roster.releasedMinor, roster.currency),
      },
    };
  }

  @Operation('getRosterCreator')
  async get(@ValidatedParams() params: CreatorParams): Promise<CreatorDetailDto> {
    const creator = await this.roster.get(params.orgId, params.creatorId);
    return {
      ...this.toDto(creator, creator.currency),
      bio: creator.bio,
      deals: creator.deals.map((deal) => ({
        dealId: deal.dealId,
        campaignName: deal.campaignName,
        state: deal.state as CreatorDetailDto['deals'][number]['state'],
        total: money(deal.totalMinor, deal.currency),
        released: money(deal.releasedMinor, deal.currency),
        createdAt: deal.createdAt.toISOString(),
      })),
    };
  }

  private toDto(
    creator: {
      creatorId: string;
      handle: string;
      displayName: string | null;
      payoutsEnabled: boolean;
      payoutHoldUntil: Date | null;
      dealCount: number;
      activeDealCount: number;
      totalReleasedMinor: bigint;
      totalCommittedMinor: bigint;
      deliverablesApproved: number;
      approvalRateBps: number | null;
      firstDealAt: Date | null;
      lastActivityAt: Date | null;
    },
    currency: string,
  ): CreatorDto {
    return {
      creatorId: creator.creatorId,
      handle: creator.handle,
      displayName: creator.displayName,
      payoutsEnabled: creator.payoutsEnabled,
      payoutHoldUntil: creator.payoutHoldUntil?.toISOString() ?? null,
      dealCount: creator.dealCount,
      activeDealCount: creator.activeDealCount,
      totalReleased: money(creator.totalReleasedMinor, currency),
      totalCommitted: money(creator.totalCommittedMinor, currency),
      deliverablesApproved: creator.deliverablesApproved,
      approvalRateBps: creator.approvalRateBps,
      firstDealAt: creator.firstDealAt?.toISOString() ?? null,
      lastActivityAt: creator.lastActivityAt?.toISOString() ?? null,
    };
  }
}
