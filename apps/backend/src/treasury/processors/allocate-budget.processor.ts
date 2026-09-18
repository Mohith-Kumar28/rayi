import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@/database/prisma.service';
import { AccountRole, Direction } from '@/ledger/domain/ledger.types';
import { LedgerRepository } from '@/ledger/infrastructure/ledger.repository';
import { sqlStateOf } from '@/ledger/infrastructure/retry';

import { PermissionService } from '@/authorization/permission.service';

/**
 * The worker half of the vertical slice.
 *
 * Runs in the `worker` process — the one with no listening socket, no target
 * group and no inbound security-group rule. Nothing can call it; it picks work
 * up from the database.
 *
 * The rule it obeys throughout: **the command is a pointer, never an
 * instruction.** It re-derives every authoritative value and re-checks
 * authorization, because a command may be executed long after it was written —
 * a weekly payout sweep runs seven days later, by which time the approver may
 * have been demoted or removed.
 */
/**
 * Statuses that still represent work. `pending` is unclaimed; `processing` is
 * claimed by a worker, which is what this processor sees for anything the queue
 * handed it.
 */
const LIVE_STATUSES: string[] = ['pending', 'processing'];

@Injectable()
export class AllocateBudgetProcessor {
  private readonly logger = new Logger(AllocateBudgetProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerRepository,
    private readonly permissions: PermissionService,
  ) {}

  async process(commandId: string): Promise<void> {
    const command = await this.prisma.treasuryCommand.findUnique({
      where: { id: commandId },
    });

    if (!command) {
      // Not an error worth retrying: the row is gone, so there is nothing to do
      // and no amount of redelivery will produce one.
      this.logger.error(`Treasury command ${commandId} not found.`);
      return;
    }

    if (command.kind !== 'ALLOCATE_BUDGET') {
      await this.fail(commandId, `wrong_processor:${command.kind}`);
      return;
    }

    // Already done, or already refused. Reaching here twice is expected —
    // at-least-once delivery is the contract — so this is a normal path.
    if (command.status === 'completed' || command.status === 'failed') {
      this.logger.log(
        `Command ${commandId} is already ${command.status}; nothing to do.`,
      );
      return;
    }

    try {
      // 1. RE-CHECK AUTHORIZATION. The command records who asked and under what
      //    authority; it is not evidence that they still hold it. Between the
      //    request and this moment a member may have been removed, demoted, or
      //    had their MoneyAuthority revoked — and a payout sweep executes days
      //    later, which is precisely when that gap is exploitable.
      await this.reauthorize(command);

      // 2. RE-DERIVE THE ACCOUNTS. Neither side is read from the command: the
      //    campaign account is derived from the campaign (which carries its own
      //    organization), and the funding lot from the organization. A caller
      //    therefore has no way to express "post this somewhere else".
      if (!command.campaignId) {
        await this.fail(commandId, 'missing_campaign');
        return;
      }

      const campaignAccount = await this.ledger.accountForCampaign(
        command.campaignId,
        AccountRole.CampaignAllocated,
        command.currency,
      );
      const orgLot = await this.ledger.orgLotToSpend(
        command.organizationId,
        command.currency,
      );

      // 2b. VERIFY THE REQUESTER'S ASSERTION about what was available.
      //
      //     Not a duplicate of the solvency constraint. The CHECK stops an
      //     allocation that cannot be afforded; this stops one that CAN be
      //     afforded but was sized against a figure that has since changed.
      //     Someone allocating $8,000 of a displayed $10,000 means "most of
      //     it" — and if a colleague spent $7,000 in the meantime, $8,000 is no
      //     longer that decision, even though it still fits.
      //
      //     It fails the command rather than adjusting the amount. Guessing what
      //     the user would have wanted is how a system pays a number nobody
      //     chose.
      //
      //     Read-then-post is NOT a lock, and is not meant to be: another
      //     allocation can land between these two statements. Solvency is not
      //     what this protects — the non-negative CHECK does that, atomically.
      //     This protects INTENT, and intent only has to be fresh as of the
      //     decision, not held under a lock until it executes.
      if (command.expectedAvailableMinor !== null) {
        const actual = await this.ledger.balanceOf(orgLot);
        if (actual !== command.expectedAvailableMinor) {
          await this.fail(
            commandId,
            `stale_balance: requester saw ${command.expectedAvailableMinor}, actual ${actual}`,
          );
          return;
        }
      }

      // 3. POST. Idempotency is keyed on the COMMAND, so a redelivered job posts
      //    nothing new: post_entry returns the existing entry id rather than
      //    raising, and the balance moves exactly once.
      const entryId = await this.ledger.postEntry({
        transition: 'ALLOCATE_BUDGET',
        sourceType: 'treasury_command',
        sourceId: command.id,
        lines: [
          {
            accountId: campaignAccount,
            direction: Direction.Debit,
            amountMinor: command.amountMinor,
          },
          {
            accountId: orgLot,
            direction: Direction.Credit,
            amountMinor: command.amountMinor,
          },
        ],
        requestId: command.requestId ?? undefined,
      });

      // Guarded on `status: 'pending'` so two concurrent deliveries cannot both
      // claim to have completed it. Both will have received the SAME entry id
      // from `post_entry` — it converges rather than refusing the loser — so
      // this simply records which run got there first and leaves the other a
      // no-op.
      await this.prisma.treasuryCommand.updateMany({
        where: { id: commandId, status: { in: LIVE_STATUSES } },
        data: {
          status: 'completed',
          ledgerEntryId: entryId,
          processedAt: new Date(),
          claimedAt: null,
          claimedBy: null,
        },
      });

      this.logger.log(
        `Command ${commandId} posted as ledger entry ${entryId}.`,
      );
    } catch (error) {
      // An overdraft is the database being RIGHT — a terminal refusal, not
      // something to retry. `withRetry` inside the repository has already
      // exhausted anything genuinely transient before control reaches here, so
      // everything arriving at this point is final.
      const reason = this.describe(error);
      await this.fail(commandId, reason);
      throw error;
    }
  }

  /**
   * Re-derives, from current state, whether this allocation may still proceed.
   *
   * Throws rather than returning a boolean: a caller that forgot to check the
   * result would post the entry anyway, and the whole point of this method is
   * that skipping it must not be possible by omission.
   */
  private async reauthorize(command: {
    actorUserId: string;
    organizationId: string;
    workspaceId: string | null;
    amountMinor: bigint;
  }): Promise<void> {
    const scope = {
      organizationId: command.organizationId,
      ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
    };

    const permitted = await this.permissions.can(
      command.actorUserId,
      'campaign:allocate',
      scope,
    );
    if (!permitted) {
      throw new Error('authorization_revoked:permission');
    }

    const authority = await this.permissions.hasMoneyAuthority(
      command.actorUserId,
      'campaign:allocate',
      scope,
      command.amountMinor,
    );
    if (!authority.granted) {
      throw new Error(`authorization_revoked:${authority.reason}`);
    }
  }

  /**
   * A failure reason that names the CONSTRAINT rather than the driver's prose.
   *
   * The constraint name is stable and greppable; the message around it is not.
   * Support and alerting both key on this string, so it has to survive a driver
   * upgrade rewording its errors.
   */
  private describe(error: unknown): string {
    const sqlState = sqlStateOf(error);
    const message = error instanceof Error ? error.message : String(error);
    const constraint =
      /constraint "([^"]+)"|violates check constraint "([^"]+)"|(\w*account_balance_non_negative\w*)/.exec(
        message,
      );
    const named = constraint?.[1] ?? constraint?.[2] ?? constraint?.[3];
    return [sqlState ? `sqlstate=${sqlState}` : null, named, message]
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);
  }

  private async fail(commandId: string, reason: string): Promise<void> {
    await this.prisma.treasuryCommand.updateMany({
      where: { id: commandId, status: 'pending' },
      data: {
        status: 'failed',
        failureReason: reason.slice(0, 500),
        processedAt: new Date(),
      },
    });
  }
}
