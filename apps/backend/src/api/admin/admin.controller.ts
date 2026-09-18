import { Controller, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { assertCurrency, exponentOf, type Currency } from '@rayi/domain';
import type { z } from 'zod';
import type {
  BrandSummarySchema,
  LedgerHealthSchema,
  PlatformStatsSchema,
} from '@rayi/contracts';

import { auditActionCopy } from '@/audit/audit.types';
import {
  ValidatedParams,
  ValidatedQuery,
} from '@/decorators/operation-input.decorator';
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
/// Derived from the currency, never a literal 2 — a `?? 2` misformats a
/// three-decimal currency by 10x, and there is none in this codebase.
const PLATFORM_EXPONENT = exponentOf(PLATFORM_CURRENCY);

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

  // -------------------------------------------------------------------------
  // Operational surfaces
  // -------------------------------------------------------------------------

  @Operation('getBrandDetail')
  async brandDetail(@ValidatedParams() params: { brandId: string }) {
    const brand = await this.admin.brandDetail(params.brandId);
    if (!brand) throw new NotFoundException();

    return {
      organizationId: brand.organizationId,
      name: brand.name,
      slug: brand.slug,
      createdAt: brand.createdAt.toISOString(),
      memberCount: brand.memberCount,
      campaignCount: brand.campaignCount,
      activeDealCount: brand.activeDealCount,
      frozen: brand.frozen,
      bankAccountStatus: brand.bankAccountStatus,
      funded: money(brand.fundedMinor, PLATFORM_EXPONENT),
      allocated: money(brand.allocatedMinor, PLATFORM_EXPONENT),
      released: money(brand.releasedMinor, PLATFORM_EXPONENT),
      computedAt: brand.computedAt?.toISOString() ?? null,
      workspaces: brand.workspaces,
      owners: brand.owners,
    };
  }

  @Operation('listPlatformCreators')
  async listCreators(
    @ValidatedQuery() query: { search?: string; blockedOnly?: boolean } | undefined,
  ) {
    const result = await this.admin.listCreators({
      ...(query?.search ? { search: query.search } : {}),
      ...(query?.blockedOnly ? { blockedOnly: true } : {}),
    });

    return {
      creators: result.creators.map((creator) => ({
        creatorId: creator.creatorId,
        handle: creator.handle,
        email: creator.email,
        payoutsEnabled: creator.payoutsEnabled,
        payoutHoldUntil: creator.payoutHoldUntil?.toISOString() ?? null,
        brandCount: creator.brandCount,
        activeDealCount: creator.activeDealCount,
        totalReleased: money(creator.releasedMinor, PLATFORM_EXPONENT),
        joinedAt: creator.joinedAt.toISOString(),
      })),
      blockedCount: result.blockedCount,
    };
  }

  @Operation('listTreasuryCommands')
  async listTreasuryCommands(@ValidatedQuery() query: { state?: string } | undefined) {
    const result = await this.admin.listTreasuryCommands(
      query?.state ? { state: query.state } : {},
    );

    return {
      commands: result.commands.map((command) => ({
        commandId: command.id,
        kind: command.kind,
        state: command.state as 'pending' | 'claimed' | 'succeeded' | 'failed' | 'abandoned',
        organizationId: command.organizationId,
        organizationName: command.organizationName,
        attempts: command.attempts,
        claimedBy: command.claimedBy,
        claimedAt: command.claimedAt?.toISOString() ?? null,
        createdAt: command.createdAt.toISOString(),
        lastError: command.lastError,
        expectedAvailable:
          command.expectedAvailableMinor == null
            ? null
            : money(command.expectedAvailableMinor, PLATFORM_EXPONENT),
      })),
      failedCount: result.failedCount,
      stuckCount: result.stuckCount,
    };
  }

  @Operation('listWebhookDeliveries')
  async listWebhooks(
    @ValidatedQuery() query: { source?: string; failedOnly?: boolean } | undefined,
  ) {
    const result = await this.admin.listWebhookDeliveries({
      ...(query?.source ? { source: query.source } : {}),
      ...(query?.failedOnly ? { failedOnly: true } : {}),
    });

    return {
      deliveries: result.deliveries.map((delivery) => ({
        deliveryId: delivery.id,
        source: delivery.source as 'stripe_platform' | 'stripe_connect' | 'resend',
        eventType: delivery.eventType,
        state: delivery.state as 'received' | 'processed' | 'failed' | 'ignored',
        receivedAt: delivery.receivedAt.toISOString(),
        processedAt: delivery.processedAt?.toISOString() ?? null,
        lastError: delivery.lastError,
      })),
      failedCount: result.failedCount,
      unprocessedCount: result.unprocessedCount,
    };
  }

  @Operation('listAuditEvents')
  async listAudit(
    @ValidatedQuery()
    query: { action?: string; organizationId?: string; moneyOnly?: boolean } | undefined,
  ) {
    const result = await this.admin.listAuditEvents({
      ...(query?.action ? { action: query.action } : {}),
      ...(query?.organizationId ? { organizationId: query.organizationId } : {}),
      ...(query?.moneyOnly ? { moneyOnly: true } : {}),
    });

    return {
      events: result.events.map((event) => ({
        seq: event.seq,
        occurredAt: event.occurredAt.toISOString(),
        action: event.action,
        // The sentence and the key travel together: the key is what an alert
        // matches on, the label is what a person can evaluate.
        label: auditActionCopy(event.action),
        actorEmail: event.actorEmail,
        organizationId: event.organizationId,
        organizationName: event.organizationName,
        ipAddress: event.ipAddress,
        chainValid: event.chainValid,
      })),
      chainBreakCount: result.chainBreakCount,
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
