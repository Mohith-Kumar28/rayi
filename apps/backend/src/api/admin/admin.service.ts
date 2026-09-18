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

  // -------------------------------------------------------------------------
  // Operational surfaces
  //
  // Read-only, like everything above. An admin surface that can also act is a
  // single session that can move any brand's money.
  // -------------------------------------------------------------------------

  /** One brand, with the figures the worker last computed for the platform. */
  async brandDetail(brandId: string) {
    const organization = await this.scope.crossTenant('admin: brand detail', (tx) =>
      tx.organization.findUnique({
        where: { id: brandId },
        select: {
          id: true,
          name: true,
          slug: true,
          createdAt: true,
          _count: { select: { members: true } },
          members: {
            where: { role: { in: ['owner', 'admin'] } },
            select: { role: true, user: { select: { email: true } } },
            orderBy: { createdAt: 'asc' },
            take: 20,
          },
          workspaces: {
            select: { id: true, name: true, _count: { select: { campaigns: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
    );

    if (!organization) return null;

    const counts = await this.scope.crossTenant('admin: brand counts', async (tx) => ({
      campaigns: await tx.campaign.count({ where: { organizationId: brandId } }),
      deals: await tx.deal.count({
        where: { organizationId: brandId, state: { in: ['active', 'accepted'] } },
      }),
      released: await tx.milestone.findMany({
        where: { releasedAt: { not: null }, agreementVersion: { deal: { organizationId: brandId } } },
        select: { amountMinor: true },
      }),
      committed: await tx.deal.findMany({
        where: { organizationId: brandId, state: { in: ['offered', 'accepted', 'active'] } },
        select: { totalAmountMinor: true },
      }),
    }));

    const snapshot = await this.snapshot();

    return {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      memberCount: organization._count.members,
      campaignCount: counts.campaigns,
      activeDealCount: counts.deals,
      frozen: false,
      bankAccountStatus: 'none' as const,
      /*
       * Derived from the deal rows, NOT from the ledger.
       *
       * `rayi_api` has no grants on the ledger schema at all, so reading a
       * balance here would fail in production while passing in development as a
       * superuser — the worst kind of difference, because it only appears once
       * real money is behind it. `funded` therefore stays zero and is timestamped
       * from the worker snapshot rather than invented.
       */
      fundedMinor: 0n,
      allocatedMinor: counts.committed.reduce((sum, deal) => sum + deal.totalAmountMinor, 0n),
      releasedMinor: counts.released.reduce((sum, milestone) => sum + milestone.amountMinor, 0n),
      computedAt: snapshot?.computedAt ?? null,
      workspaces: organization.workspaces.map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        campaignCount: workspace._count.campaigns,
      })),
      owners: organization.members.map((member) => ({
        email: member.user.email,
        role: member.role,
      })),
    };
  }

  /**
   * Every creator, with the one question this screen is for: who is owed money
   * and cannot receive it.
   *
   * A creator with nothing owed and no payout method is not a problem. A
   * creator with money waiting and a blocked destination is a person, waiting —
   * so `blockedCount` counts only the second.
   */
  async listCreators(filters: { search?: string; blockedOnly?: boolean }) {
    const users = await this.scope.crossTenant('admin: list creators', (tx) =>
      tx.user.findMany({
        where: {
          deals: { some: {} },
          ...(filters.search
            ? { username: { contains: filters.search.replace(/^@/, ''), mode: 'insensitive' } }
            : {}),
        },
        select: {
          id: true,
          username: true,
          email: true,
          createdAt: true,
          payoutDestination: { select: { payoutsEnabled: true, holdUntil: true } },
          deals: {
            select: {
              organizationId: true,
              state: true,
              agreements: {
                where: { supersededAt: null },
                select: { milestones: { select: { amountMinor: true, releasedAt: true } } },
                take: 1,
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    );

    const now = new Date();
    const rows = users.map((user) => {
      const releasedMinor = user.deals.reduce(
        (sum, deal) =>
          sum +
          (deal.agreements[0]?.milestones ?? []).reduce(
            (inner, milestone) => (milestone.releasedAt ? inner + milestone.amountMinor : inner),
            0n,
          ),
        0n,
      );
      const held = user.payoutDestination?.holdUntil
        ? user.payoutDestination.holdUntil > now
        : false;
      return {
        creatorId: user.id,
        handle: `@${user.username}`,
        email: user.email,
        // Absent destination is NOT enabled. Defaulting the other way would
        // report creators as payable who are not.
        payoutsEnabled: user.payoutDestination?.payoutsEnabled ?? false,
        payoutHoldUntil: held ? (user.payoutDestination?.holdUntil ?? null) : null,
        brandCount: new Set(user.deals.map((deal) => deal.organizationId)).size,
        activeDealCount: user.deals.filter((deal) =>
          ['accepted', 'active'].includes(deal.state),
        ).length,
        releasedMinor,
        joinedAt: user.createdAt,
      };
    });

    const blockedCount = rows.filter(
      (row) => (!row.payoutsEnabled || row.payoutHoldUntil !== null) && row.releasedMinor > 0n,
    ).length;

    const creators = (
      filters.blockedOnly
        ? rows.filter((row) => !row.payoutsEnabled || row.payoutHoldUntil !== null)
        : rows
    ).sort((a, b) => {
      // Blocked first, because the screen says so and because they are the only
      // rows anybody acts on. Within each group, most money owed first.
      const blocked = (row: typeof a) =>
        !row.payoutsEnabled || row.payoutHoldUntil !== null ? 0 : 1;
      return blocked(a) - blocked(b) || (b.releasedMinor > a.releasedMinor ? 1 : -1);
    });

    return { creators, blockedCount };
  }

  /**
   * The treasury command inbox.
   *
   * The internal RPC is a row, so the queue IS a table. A `failed` command is
   * money work that was requested and did not happen; a command claimed long ago
   * is a worker that died holding the lease. Neither announces itself anywhere
   * else.
   */
  async listTreasuryCommands(filters: { state?: string }, now: Date = new Date()) {
    const commands = await this.scope.crossTenant('admin: treasury commands', (tx) =>
      tx.treasuryCommand.findMany({
        where: filters.state ? { status: filters.state } : {},
        select: {
          id: true,
          kind: true,
          // The column is `status`; the contract calls it `state`. Mapped once,
          // here, rather than renaming a column the worker depends on.
          status: true,
          organizationId: true,
          attempts: true,
          claimedBy: true,
          claimedAt: true,
          createdAt: true,
          failureReason: true,
          expectedAvailableMinor: true,
          currency: true,
        },
        // Failed first: every one of them is somebody waiting.
        orderBy: [{ createdAt: 'desc' }],
        take: 200,
      }),
    );

    const orgIds = [...new Set(commands.map((command) => command.organizationId))];
    const organizations = await this.scope.crossTenant('admin: command org names', (tx) =>
      tx.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true },
      }),
    );
    const nameById = new Map(organizations.map((org) => [org.id, org.name]));

    const STUCK_AFTER_MS = 15 * 60 * 1000;

    return {
      commands: commands
        .map((command) => ({
          ...command,
          state: command.status,
          lastError: command.failureReason,
          organizationName: nameById.get(command.organizationId) ?? 'unknown',
        }))
        .sort((a, b) => {
          const rank = (state: string) => (state === 'failed' ? 0 : state === 'claimed' ? 1 : 2);
          return rank(a.state) - rank(b.state) || b.createdAt.getTime() - a.createdAt.getTime();
        }),
      failedCount: commands.filter((command) => command.status === 'failed').length,
      stuckCount: commands.filter(
        (command) =>
          command.status === 'claimed' &&
          command.claimedAt != null &&
          now.getTime() - command.claimedAt.getTime() > STUCK_AFTER_MS,
      ).length,
    };
  }

  /**
   * Recent webhook deliveries.
   *
   * A verified delivery nobody processed has a three-day fuse — the provider
   * retries for that long and then stops — and an ACH return arrives through
   * this path as a dispute. Losing one means a brand's money came back and the
   * ledger never heard about it.
   */
  async listWebhookDeliveries(filters: { source?: string; failedOnly?: boolean }) {
    const deliveries = await this.scope.crossTenant('admin: webhook deliveries', (tx) =>
      tx.webhookEvent.findMany({
        where: {
          ...(filters.source ? { source: filters.source } : {}),
          ...(filters.failedOnly ? { status: 'failed' } : {}),
        },
        select: {
          id: true,
          source: true,
          eventType: true,
          status: true,
          receivedAt: true,
          processedAt: true,
          failureReason: true,
        },
        orderBy: { receivedAt: 'desc' },
        take: 200,
      }),
    );

    const all = await this.scope.crossTenant('admin: webhook counts', (tx) =>
      tx.webhookEvent.groupBy({ by: ['status'], _count: { _all: true } }),
    );
    const countOf = (status: string) =>
      all.find((row) => row.status === status)?._count._all ?? 0;

    return {
      deliveries: deliveries.map((delivery) => ({
        ...delivery,
        state: delivery.status,
        lastError: delivery.failureReason,
      })),
      failedCount: countOf('failed'),
      // Verified, stored, and never interpreted. The queue nobody drained.
      unprocessedCount: countOf('pending'),
    };
  }

  /**
   * The audit log, across tenants.
   *
   * `chainValid` is per row so a break is LOCATED rather than merely counted.
   * The sequence is deliberately not checked for gaps: the column is
   * `GENERATED ALWAYS AS IDENTITY`, which is monotonic but not gapless — a
   * rolled-back transaction burns a value — so a gap alarm would fire on every
   * failed request and be switched off within a week.
   */
  async listAuditEvents(filters: {
    action?: string;
    organizationId?: string;
    moneyOnly?: boolean;
  }) {
    const MONEY_PREFIXES = ['treasury.', 'money_authority.', 'deliverable.', 'milestone.'];

    /*
     * Raw SQL, because `audit.event` is deliberately NOT a Prisma model.
     *
     * The table is append-only, hash-chained, and lives in its own schema with
     * UPDATE and DELETE revoked. Exposing it through the ORM would put a
     * `.update()` and a `.delete()` on it in every developer's autocomplete —
     * calls the database would reject, but only at runtime, and only once
     * somebody had written the code believing they were allowed to.
     */
    const like = filters.action ? `%${filters.action}%` : null;
    const events = await this.scope.crossTenant('admin: audit log', (tx) =>
      tx.$queryRaw<
        Array<{
          seq: bigint;
          occurred_at: Date;
          action: string;
          organization_id: string | null;
          actor_user_id: string | null;
          ip_address: string | null;
        }>
      >`
        SELECT seq, occurred_at, action, organization_id, actor_user_id, host(ip_address) AS ip_address
        FROM audit.event
        WHERE (${like}::text IS NULL OR action LIKE ${like}::text)
          AND (${filters.organizationId ?? null}::text IS NULL
               OR organization_id = ${filters.organizationId ?? null}::text)
          AND (${filters.moneyOnly ?? false}::boolean IS NOT TRUE
               OR action LIKE 'treasury.%'
               OR action LIKE 'money_authority.%'
               OR action LIKE 'deliverable.%'
               OR action LIKE 'milestone.%')
        ORDER BY seq DESC
        LIMIT 200
      `,
    );

    const orgIds = [...new Set(events.map((event) => event.organization_id).filter(Boolean))];
    const actorIds = [...new Set(events.map((event) => event.actor_user_id).filter(Boolean))];

    const [organizations, actors, breaks] = await Promise.all([
      this.scope.crossTenant('admin: audit org names', (tx) =>
        tx.organization.findMany({
          where: { id: { in: orgIds as string[] } },
          select: { id: true, name: true },
        }),
      ),
      this.scope.crossTenant('admin: audit actor emails', (tx) =>
        tx.user.findMany({
          where: { id: { in: actorIds as string[] } },
          select: { id: true, email: true },
        }),
      ),
      this.verifyChain(),
    ]);

    const orgName = new Map(organizations.map((org) => [org.id, org.name]));
    const actorEmail = new Map(actors.map((user) => [user.id, user.email]));

    return {
      events: events.map((event) => ({
        seq: event.seq.toString(),
        occurredAt: event.occurred_at,
        action: event.action,
        actorEmail: event.actor_user_id ? (actorEmail.get(event.actor_user_id) ?? null) : null,
        organizationId: event.organization_id,
        organizationName: event.organization_id
          ? (orgName.get(event.organization_id) ?? null)
          : null,
        // `host()` strips the /32 an `inet` column renders — the same rendering
        // difference that once made every IP-carrying audit row verify as
        // tampered.
        ipAddress: event.ip_address,
        chainValid: !breaks.has(event.seq.toString()),
      })),
      chainBreakCount: breaks.size,
    };
  }

  /** Sequence numbers whose stored hash no longer matches the chain. */
  private async verifyChain(): Promise<Set<string>> {
    const rows = await this.scope.crossTenant('admin: verify audit chain', (tx) =>
      tx.$queryRaw<Array<{ seq: bigint }>>`SELECT seq FROM audit.verify_chain()`,
    );
    return new Set(rows.map((row) => row.seq.toString()));
  }
}
