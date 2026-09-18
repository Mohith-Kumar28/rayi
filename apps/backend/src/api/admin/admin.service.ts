import { Injectable } from '@nestjs/common';

import { TenantScope } from '@/database/tenant-scope';

/**
 * The super-admin surface. **The only code that reads across tenants.**
 *
 * Every query goes through `TenantScope.crossTenant(reason)`, which logs each
 * call — rather than granting the application role `BYPASSRLS`, which would make
 * every row-level security policy decorative. A cross-tenant read nobody can
 * account for is the first sign one was added carelessly, and the log line is
 * what makes that visible.
 *
 * Read-only, deliberately. An admin surface that can also act is a single
 * session that can move any brand's money.
 */

export interface BrandSummary {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly memberCount: number;
  readonly campaignCount: number;
  readonly activeDealCount: number;
}

export interface PlatformSnapshotView {
  readonly brandCount: number;
  readonly creatorCount: number;
  readonly activeDealCount: number;
  readonly pendingReviews: number;
  readonly releasedToCreatorsMinor: bigint;
  readonly fundsUnderManagementMinor: bigint;
  readonly platformRevenueMinor: bigint;
  readonly unbalancedEntryIds: readonly string[];
  readonly driftedAccountIds: readonly string[];
  readonly auditChainBreaks: ReadonlyArray<{ seq: string; reason: string }>;
  readonly failedCommandCount: number;
  readonly computedAt: Date;
}

@Injectable()
export class AdminService {
  constructor(private readonly scope: TenantScope) {}

  /**
   * Every brand, with counts.
   *
   * Deliberately NO ledger figures. `rayi_api` has no grants on the `ledger`
   * schema at all, so reading balances here would fail in production while
   * passing in development as a superuser — the worst kind of difference. Money
   * figures come from the worker-computed snapshot below.
   */
  async listBrands(): Promise<BrandSummary[]> {
    const organizations = await this.scope.crossTenant('admin: list brands', (tx) =>
      tx.organization.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          _count: { select: { members: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );

    const summaries: BrandSummary[] = [];

    for (const organization of organizations) {
      const counts = await this.scope.crossTenant('admin: brand counts', async (tx) => ({
        campaigns: await tx.campaign.count({ where: { organizationId: organization.id } }),
        deals: await tx.deal.count({
          where: { organizationId: organization.id, state: { in: ['active', 'accepted'] } },
        }),
      }));

      summaries.push({
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdAt: organization.createdAt,
        memberCount: organization._count.members,
        campaignCount: counts.campaigns,
        activeDealCount: counts.deals,
      });
    }

    return summaries;
  }

  /**
   * The platform snapshot, as the worker last computed it.
   *
   * Returns `null` when none has been computed yet — and the UI says so, rather
   * than rendering zeros. Zeros on a revenue dashboard are indistinguishable
   * from a business that has earned nothing, and somebody will screenshot them.
   */
  async snapshot(): Promise<PlatformSnapshotView | null> {
    const row = await this.scope.crossTenant('admin: platform snapshot', (tx) =>
      tx.platformSnapshot.findFirst(),
    );

    if (!row) return null;

    return {
      brandCount: row.brandCount,
      creatorCount: row.creatorCount,
      activeDealCount: row.activeDealCount,
      pendingReviews: row.pendingReviews,
      releasedToCreatorsMinor: row.releasedToCreatorsMinor,
      fundsUnderManagementMinor: row.fundsUnderManagementMinor,
      platformRevenueMinor: row.platformRevenueMinor,
      unbalancedEntryIds: row.unbalancedEntryIds,
      driftedAccountIds: row.driftedAccountIds,
      auditChainBreaks: row.auditChainBreaks as Array<{ seq: string; reason: string }>,
      failedCommandCount: row.failedCommandCount,
      computedAt: row.computedAt,
    };
  }
}
