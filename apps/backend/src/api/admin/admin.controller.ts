import { Controller, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { assertCurrency, exponentOf, type Currency } from '@rayi/domain';
import type { z } from 'zod';
import type {
  BrandSummarySchema,
  LedgerHealthSchema,
  PlatformStatsSchema,
} from '@rayi/contracts';

import { Operation } from '@/decorators/operation.decorator';

import { AdminService } from './admin.service';

/**
 * The super-admin surface.
 *
 * Every route is `platform:read`, which no organization role holds — an org
 * owner cannot reach these however senior they are. `PermissionGuard` resolves
 * the permission from the user's own role, never from a membership, and the
 * manifest test asserts a `platform:` route never carries an `{orgId}`.
 *
 * Read-only. An admin surface that can also act is a single session that can
 * move any brand's money.
 */

type BrandDto = z.infer<typeof BrandSummarySchema>;
type StatsDto = z.infer<typeof PlatformStatsSchema>;
type HealthDto = z.infer<typeof LedgerHealthSchema>;

/** Platform figures are reported in the platform's own currency. */
const PLATFORM_CURRENCY: Currency = 'USD';

@ApiTags('admin')
@Controller()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Operation('listBrands')
  async brands(): Promise<{ brands: BrandDto[] }> {
    const brands = await this.admin.listBrands();
    return {
      brands: brands.map((brand) => ({
        organizationId: brand.organizationId,
        name: brand.name,
        slug: brand.slug,
        createdAt: brand.createdAt.toISOString(),
        memberCount: brand.memberCount,
        campaignCount: brand.campaignCount,
        activeDealCount: brand.activeDealCount,
      })),
    };
  }

  @Operation('getPlatformStats')
  async stats(): Promise<StatsDto> {
    const snapshot = await this.admin.snapshot();

    if (!snapshot) {
      // 503, not zeros. Zeros on a revenue dashboard are indistinguishable from
      // a business that has earned nothing, and somebody will screenshot them.
      throw new ServiceUnavailableException(
        'No platform snapshot has been computed yet. The worker computes one every five minutes.',
      );
    }

    const exponent = exponentOf(PLATFORM_CURRENCY);

    return {
      brandCount: snapshot.brandCount,
      creatorCount: snapshot.creatorCount,
      activeDealCount: snapshot.activeDealCount,
      pendingReviews: snapshot.pendingReviews,
      releasedToCreators: money(snapshot.releasedToCreatorsMinor, exponent),
      // Brands' money at Stripe. A DIFFERENT number from revenue, and never
      // added to it.
      fundsUnderManagement: money(snapshot.fundsUnderManagementMinor, exponent),
      platformRevenue: money(snapshot.platformRevenueMinor, exponent),
      computedAt: snapshot.computedAt.toISOString(),
    };
  }

  @Operation('getLedgerHealth')
  async health(): Promise<HealthDto> {
    const snapshot = await this.admin.snapshot();

    if (!snapshot) {
      // Empty lists here would read as "the books are fine", which is the one
      // thing this endpoint must never say without having checked.
      return {
        checkedAt: null,
        unbalancedEntries: [],
        driftedAccounts: [],
        auditChainBreaks: [],
        failedCommands: 0,
      };
    }

    return {
      checkedAt: snapshot.computedAt.toISOString(),
      unbalancedEntries: [...snapshot.unbalancedEntryIds],
      driftedAccounts: [...snapshot.driftedAccountIds],
      auditChainBreaks: snapshot.auditChainBreaks.map((row) => ({ ...row })),
      failedCommands: snapshot.failedCommandCount,
    };
  }
}

function money(amountMinor: bigint, exponent: number) {
  return {
    amountMinor: amountMinor.toString(),
    currency: assertCurrency(PLATFORM_CURRENCY),
    exponent,
  };
}
