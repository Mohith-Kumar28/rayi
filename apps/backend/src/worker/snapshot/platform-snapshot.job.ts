import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/database/prisma.service';
import { TenantScope } from '@/database/tenant-scope';
import { LedgerRepository } from '@/ledger/infrastructure/ledger.repository';

/**
 * Computes the platform snapshot the admin surface reads.
 *
 * **Why the worker and not the api.** `rayi_api` has no grants on the `ledger`
 * schema at all, so an admin endpoint reading balances would fail in production
 * while passing in development as a superuser — the worst kind of difference,
 * because the environment that catches it is the one that has users in it.
 *
 * It is also the better shape operationally. The health check verifies EVERY
 * account's balance against the sum of its lines, which does not belong in a
 * request path — and figures behind a board deck should be computed on a
 * schedule anyway. A number four minutes old and correct beats one that is live
 * and sometimes times out.
 *
 * **This is the nightly reconciliation, and it is the most valuable thing that
 * runs.** Every list it produces must be empty. A non-empty one means the ledger
 * disagrees with itself, and nothing else on the platform can be trusted until
 * it is explained.
 */

/** Frequent enough that an operator sees a problem the same hour it appears. */
const INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class PlatformSnapshotJob implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PlatformSnapshotJob.name);

  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: TenantScope,
    private readonly ledger: LedgerRepository,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.compute(), INTERVAL_MS);
    this.timer.unref();
    void this.compute();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async compute(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      const counts = await this.scope.crossTenant('snapshot: counts', async (tx) => ({
        brands: await tx.organization.count(),
        deals: await tx.deal.count({ where: { state: { in: ['active', 'accepted'] } } }),
        pendingReviews: await tx.deliverable.count({
          where: { state: { in: ['submitted', 'in_review'] } },
        }),
        failedCommands: await tx.treasuryCommand.count({ where: { status: 'failed' } }),
        // Creators are users who appear on a deal — not a `role` column, because
        // a creator is a counterparty rather than a member of anything.
        creators: await tx.deal
          .findMany({ select: { creatorUserId: true }, distinct: ['creatorUserId'] })
          .then((rows) => rows.length),
      }));

      const [released, underManagement, revenue] = await Promise.all([
        this.sumByRole('creator_payable'),
        this.sumByRole('org_lot_available'),
        this.sumByRole('platform_fee_revenue'),
      ]);

      const health = await this.checkLedgerHealth();

      await this.prisma.platformSnapshot.upsert({
        where: { onlyRow: true },
        create: {
          onlyRow: true,
          brandCount: counts.brands,
          creatorCount: counts.creators,
          activeDealCount: counts.deals,
          pendingReviews: counts.pendingReviews,
          releasedToCreatorsMinor: released,
          fundsUnderManagementMinor: underManagement,
          platformRevenueMinor: revenue,
          failedCommandCount: counts.failedCommands,
          ...health,
        },
        update: {
          brandCount: counts.brands,
          creatorCount: counts.creators,
          activeDealCount: counts.deals,
          pendingReviews: counts.pendingReviews,
          releasedToCreatorsMinor: released,
          fundsUnderManagementMinor: underManagement,
          platformRevenueMinor: revenue,
          failedCommandCount: counts.failedCommands,
          computedAt: new Date(),
          ...health,
        },
      });

      if (
        health.unbalancedEntryIds.length > 0 ||
        health.driftedAccountIds.length > 0 ||
        (health.auditChainBreaks as unknown[]).length > 0
      ) {
        // The loudest line this process can produce. A ledger that disagrees
        // with itself is not a degraded service — it is a service whose numbers
        // cannot be relied on until someone explains why.
        this.logger.error(
          `LEDGER INVARIANT VIOLATED: ${health.unbalancedEntryIds.length} unbalanced entries, ` +
            `${health.driftedAccountIds.length} drifted accounts, ` +
            `${(health.auditChainBreaks as unknown[]).length} audit chain breaks.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Platform snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async checkLedgerHealth(): Promise<{
    unbalancedEntryIds: string[];
    driftedAccountIds: string[];
    auditChainBreaks: Array<{ seq: string; reason: string }>;
  }> {
    const unbalanced = await this.ledger.findUnbalancedEntries();

    const accounts = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text FROM ledger.account
    `;

    const drifted: string[] = [];
    for (const account of accounts) {
      const check = await this.ledger.verifyBalance(account.id);
      if (!check.agrees) drifted.push(account.id);
    }

    const chainBreaks = await this.audit.verifyChain();

    return {
      unbalancedEntryIds: unbalanced,
      driftedAccountIds: drifted,
      auditChainBreaks: chainBreaks.map((row) => ({
        seq: row.seq.toString(),
        reason: row.reason,
      })),
    };
  }

  private async sumByRole(role: string): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(b.balance_minor), 0)::bigint AS total
        FROM ledger.account a
        JOIN ledger.account_balance b ON b.account_id = a.id
       WHERE a.role = ${role}::ledger.account_role
    `;
    return rows[0]?.total ?? 0n;
  }
}
