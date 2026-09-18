import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/database/prisma.service';

import {
  AccountRole,
  Direction,
  LedgerError,
  type PostEntryCommand,
} from '../domain/ledger.types';
import { withRetry } from './retry';
import { runInTransactionScope } from './transaction-purity';

/**
 * The only door into the ledger.
 *
 * Every write goes through `ledger.post_entry`, a SECURITY DEFINER function, so
 * this class never writes ledger tables directly — and the `rayi_api` role could
 * not do so even if it tried, since it has no grants on the schema at all.
 *
 * This is the case where a repository abstraction genuinely earns its place. It
 * is not a thin wrapper over `findMany`: it enforces balanced double-entry, takes
 * row locks in a canonical order, and hides real persistence complexity. Reads
 * of projections and dashboards should go straight to Prisma instead — a "read
 * repository" that wraps a query is the leaky wrapper the critics are right about.
 */
@Injectable()
export class LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Posts a balanced journal entry.
   *
   * Idempotent on `(sourceType, sourceId)`: replaying a Stripe webhook, retrying
   * a job or double-clicking a button converge on exactly one effect. The
   * function returns the existing entry id rather than raising, so callers need
   * no special case for "already done".
   *
   * Wrapped in `runInTransactionScope` so any Stripe or notification call
   * reached from here throws instead of silently becoming a duplicate side
   * effect on retry.
   */
  async postEntry(command: PostEntryCommand): Promise<string> {
    if (command.lines.length < 2) {
      throw new LedgerError(
        'UNBALANCED',
        `An entry needs at least two lines; received ${command.lines.length}. ` +
          `A single-sided entry is not double-entry bookkeeping.`,
      );
    }

    // Asserted here as well as in the database. The constraint is authoritative;
    // this exists so the common mistake produces a readable message naming the
    // discrepancy, rather than a constraint violation at COMMIT.
    const signedTotal = command.lines.reduce(
      (total, line) =>
        total +
        (line.direction === Direction.Debit
          ? line.amountMinor
          : -line.amountMinor),
      0n,
    );
    if (signedTotal !== 0n) {
      throw new LedgerError(
        'UNBALANCED',
        `Entry does not balance: debits minus credits = ${signedTotal}.`,
      );
    }

    const lines = command.lines.map((line) => ({
      account_id: line.accountId,
      direction: line.direction,
      // BigInt is not JSON-serialisable, and a JSON number would silently lose
      // precision past 2^53. Postgres casts the string back to bigint.
      amount_minor: line.amountMinor.toString(),
    }));

    return withRetry(() =>
      runInTransactionScope(`post_entry:${command.transition}`, async () => {
        const rows = await this.prisma.$queryRaw<Array<{ post_entry: string }>>`
          SELECT ledger.post_entry(
            ${command.transition},
            ${command.sourceType},
            ${command.sourceId},
            ${JSON.stringify(lines)}::jsonb,
            ${command.actorPrincipalId ?? null}::uuid,
            ${command.requestId ?? null},
            ${command.codeVersion ?? null}
          ) AS post_entry
        `;

        const entryId = rows[0]?.post_entry;
        if (!entryId) {
          throw new LedgerError(
            'POST_FAILED',
            'post_entry returned no entry id.',
          );
        }
        return entryId;
      }),
    );
  }

  /** Creates an account together with its balance row — they must exist as a pair. */
  async createAccount(input: {
    role: AccountRole;
    currency: string;
    normalBalance: Direction;
    allowNegative?: boolean;
    orgId?: string;
    depositId?: string;
    campaignId?: string;
    deliverableId?: string;
    creatorId?: string;
  }): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ create_account: string }>>`
      SELECT ledger.create_account(
        ${input.role}::ledger.account_role,
        ${input.currency},
        ${input.normalBalance}::ledger.direction,
        ${input.allowNegative ?? false},
        ${input.orgId ?? null}::uuid,
        ${input.depositId ?? null}::uuid,
        ${input.campaignId ?? null}::uuid,
        ${input.deliverableId ?? null}::uuid,
        ${input.creatorId ?? null}::uuid
      ) AS create_account
    `;
    const id = rows[0]?.create_account;
    if (!id)
      throw new LedgerError('POST_FAILED', 'create_account returned no id.');
    return id;
  }

  /**
   * Derives the ledger account for a campaign, creating it on first use.
   *
   * Deliberately takes a CAMPAIGN, not an account id. A caller that could name
   * an account id could name someone else's — the composite FK would still be
   * satisfied, the entry would still balance, and the money would still be in
   * the wrong organization's campaign. Here the caller names what it is acting
   * on and the database decides which account that is.
   *
   * The owning organization is read from the campaign row inside the function,
   * so the account is parented to the campaign's TRUE owner regardless of what
   * the caller believed.
   */
  async accountForCampaign(
    campaignId: string,
    role: AccountRole,
    currency: string,
  ): Promise<string> {
    const rows = await this.prisma.$queryRaw<
      Array<{ account_for_campaign: string }>
    >`
      SELECT ledger.account_for_campaign(
        ${campaignId}::uuid,
        ${role}::ledger.account_role,
        ${currency}
      ) AS account_for_campaign
    `;
    const id = rows[0]?.account_for_campaign;
    if (!id) {
      throw new LedgerError(
        'NO_SUCH_ACCOUNT',
        `No campaign account derivable for ${campaignId}.`,
      );
    }
    return id;
  }

  /**
   * The organization funding lot an allocation spends from.
   *
   * Raises rather than choosing when an org holds more than one open lot: FIFO
   * consumption across lots arrives with the deposit lifecycle. A `LIMIT 1` here
   * would silently spend from an arbitrary lot and report a balance that is
   * wrong while every constraint still passes — which is the one failure mode
   * this whole design exists to make impossible.
   */
  async orgLotToSpend(orgId: string, currency: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<
      Array<{ org_lot_to_spend: string }>
    >`
      SELECT ledger.org_lot_to_spend(${orgId}::uuid, ${currency}) AS org_lot_to_spend
    `;
    const id = rows[0]?.org_lot_to_spend;
    if (!id) {
      throw new LedgerError(
        'NO_SUCH_ACCOUNT',
        `No spendable ${currency} lot for org ${orgId}.`,
      );
    }
    return id;
  }

  /**
   * Reads a balance.
   *
   * Returns the materialised figure. `verifyBalance` below is the check that it
   * still agrees with the entries — run continuously in production, because a
   * cached balance that has drifted is worse than no cache.
   */
  async balanceOf(accountId: string): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ balance_minor: bigint }>>`
      SELECT balance_minor FROM ledger.account_balance WHERE account_id = ${accountId}::uuid
    `;
    const balance = rows[0]?.balance_minor;
    if (balance === undefined) {
      throw new LedgerError(
        'NO_SUCH_ACCOUNT',
        `No balance row for account ${accountId}.`,
      );
    }
    return balance;
  }

  /**
   * Invariant check: the materialised balance equals the sum of the entries, and
   * the latest snapshot agrees with both.
   *
   * Modern Treasury's pattern, worth stealing verbatim: when an account shows
   * drift, stop trusting its cached balance and fall back to the authoritative
   * sum until it is reconciled. A wrong balance that fails safe beats a wrong
   * balance that keeps serving.
   */
  async verifyBalance(accountId: string): Promise<{
    materialised: bigint;
    computed: bigint;
    latestSnapshot: bigint | null;
    agrees: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        materialised: bigint;
        computed: bigint;
        latest_snapshot: bigint | null;
      }>
    >`
      SELECT
        b.balance_minor AS materialised,
        -- SUM over bigint yields numeric in Postgres, which the driver returns
        -- as a string. Cast back so computed is a bigint like materialised and
        -- the equality comparison below is meaningful rather than always false.
        COALESCE((
          SELECT SUM(l.natural_minor) FROM ledger.entry_line l WHERE l.account_id = b.account_id
        ), 0)::bigint AS computed,
        (
          SELECT s.balance_after FROM ledger.balance_snapshot s
           WHERE s.account_id = b.account_id ORDER BY s.seq DESC LIMIT 1
        ) AS latest_snapshot
      FROM ledger.account_balance b
      WHERE b.account_id = ${accountId}::uuid
    `;

    const row = rows[0];
    if (!row) {
      throw new LedgerError(
        'NO_SUCH_ACCOUNT',
        `No balance row for account ${accountId}.`,
      );
    }

    return {
      materialised: row.materialised,
      computed: row.computed,
      latestSnapshot: row.latest_snapshot,
      agrees:
        row.materialised === row.computed &&
        (row.latest_snapshot === null ||
          row.latest_snapshot === row.materialised),
    };
  }

  /** Global invariant: no journal entry anywhere may fail to sum to zero. */
  async findUnbalancedEntries(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ entry_id: string }>>(
      Prisma.sql`
        SELECT entry_id FROM ledger.entry_line
         GROUP BY entry_id HAVING SUM(signed_minor) <> 0
      `,
    );
    return rows.map((row) => row.entry_id);
  }
}
