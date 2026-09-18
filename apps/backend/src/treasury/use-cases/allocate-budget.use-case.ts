import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PermissionService } from '@/authorization/permission.service';
import { PrismaService } from '@/database/prisma.service';

/**
 * Allocate budget from an organization's balance to a campaign.
 *
 * This is the API-side half of the vertical slice. It performs NO money work:
 * it validates, checks authorization, writes a `treasury_command` row and
 * returns 202. The worker does the rest.
 *
 * That split is the architecture, not a style preference. The api process holds
 * no Stripe key, has no import path to the ledger module, and its database role
 * has no grants on the `ledger` schema — so even a full compromise here cannot
 * move a cent.
 */

export interface AllocateBudgetInput {
  readonly organizationId: string;
  readonly campaignId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  /** Deterministic, derived from the intent. See TreasuryCommand.idempotencyKey. */
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly requestId?: string;
  /**
   * What the client believed the available balance was. An ASSERTION, never an
   * instruction — the server compares it against its own figure and refuses on
   * mismatch. No amount a client sends can become an amount the server acts on.
   */
  readonly expectedAvailableMinor?: bigint;
}

export interface AllocateBudgetResult {
  readonly commandId: string;
  readonly status: 'accepted';
  readonly campaignId: string;
  /** True when this exact request had already been accepted. */
  readonly replayed: boolean;
}

/**
 * Raised where a permission failure must not be distinguishable from a missing
 * resource.
 *
 * Answering 403 for a campaign in another organization turns the endpoint into
 * an existence oracle: an attacker enumerates campaign ids and learns which are
 * real from the status code alone. 404 for both leaks nothing.
 */
class NotVisible extends NotFoundException {
  constructor() {
    super('No such campaign.');
  }
}

@Injectable()
export class AllocateBudgetUseCase {
  private readonly logger = new Logger(AllocateBudgetUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  async execute(input: AllocateBudgetInput): Promise<AllocateBudgetResult> {
    if (input.amountMinor <= 0n) {
      // Not merely invalid: a negative allocation would be a WITHDRAWAL from a
      // campaign expressed as an allocation to it, reaching a transition the
      // condition catalogue never authorised.
      throw new ForbiddenException('Allocation amount must be positive.');
    }

    // 1. Resolve the campaign WITH the tenant predicate in the WHERE clause.
    //
    // Not "load it, then compare its org to mine" — that is the same check one
    // refactor away from being dropped. Here a campaign belonging to another
    // organization simply does not exist, and the workspace scope the permission
    // is evaluated against becomes a database fact rather than a path parameter.
    const campaign = await this.prisma.campaign.findFirst({
      where: { id: input.campaignId, organizationId: input.organizationId },
      select: { id: true, workspaceId: true, currency: true, state: true },
    });

    if (!campaign) throw new NotVisible();

    // The campaign's currency is authoritative. A request naming a different one
    // would otherwise post a USD amount into an EUR account — which the ledger's
    // composite FK rejects, but by then a command row exists and a worker has
    // failed a job for a reason a user cannot act on.
    if (campaign.currency !== input.currency) {
      throw new ForbiddenException(
        `This campaign is denominated in ${campaign.currency}, not ${input.currency}.`,
      );
    }

    if (campaign.state === 'cancelled' || campaign.state === 'completed') {
      throw new ForbiddenException(
        `A ${campaign.state} campaign cannot receive further budget.`,
      );
    }

    const scope = {
      organizationId: input.organizationId,
      workspaceId: campaign.workspaceId,
    };

    // 2. Does the role permit asking?
    const permitted = await this.permissions.can(
      input.actorUserId,
      'campaign:allocate',
      scope,
    );
    if (!permitted) throw new NotVisible();

    // 3. Separately: are they trusted with money, and up to this amount?
    //
    // Deliberately a second question. A role says the action is in your job
    // description; MoneyAuthority says you are trusted with funds. A campaign
    // manager legitimately has `campaign:allocate` and may still have no
    // authority to move a cent.
    const authority = await this.permissions.hasMoneyAuthority(
      input.actorUserId,
      'campaign:allocate',
      scope,
      input.amountMinor,
    );
    if (!authority.granted) {
      // Logged because a denied money action is an attack signal, not merely a
      // permission problem. Unlike step 2 this is NOT masked as a 404: the actor
      // can already see the campaign, so there is nothing left to conceal, and
      // "ask someone with authority" is the only actionable message.
      this.logger.warn(
        `Money authority denied for ${input.actorUserId} on campaign:allocate: ${authority.reason}`,
      );
      throw new ForbiddenException(
        authority.reason === 'exceeds_limit'
          ? 'This amount exceeds your approval limit.'
          : 'You are not authorised to move funds.',
      );
    }

    const member = await this.prisma.member.findFirst({
      where: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
      },
      select: { id: true },
    });
    if (!member) throw new NotVisible();

    // 4. Write the intent and enqueue the job in ONE transaction.
    //
    // This is what removes the dual-write bug. If the job lived in Redis it could
    // not join this transaction, and a crash between the two writes would leave
    // a command nobody processes — or a job referencing a command that was rolled
    // back. Both halves commit together or neither does.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.treasuryCommand.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: {
          id: true,
          campaignId: true,
          organizationId: true,
          amountMinor: true,
          currency: true,
          expectedAvailableMinor: true,
        },
      });

      if (existing) {
        // A replay — a refresh, a second tab, a retried request. Return the
        // original rather than erroring: the caller wanted this to have happened,
        // and it has.
        //
        // But only if it is genuinely the same request. A key that arrives with
        // DIFFERENT terms is not a replay, it is either a client bug or an
        // attempt to have one approval pay for a larger amount, and returning
        // 202 would tell the caller their new amount was accepted when the
        // original will be what actually posts.
        const sameRequest =
          existing.organizationId === input.organizationId &&
          existing.campaignId === input.campaignId &&
          existing.amountMinor === input.amountMinor &&
          existing.currency === input.currency &&
          existing.expectedAvailableMinor === (input.expectedAvailableMinor ?? null);

        if (!sameRequest) {
          this.logger.warn(
            `Idempotency key ${input.idempotencyKey} reused with different terms by ${input.actorUserId}.`,
          );
          throw new ForbiddenException(
            'This request id has already been used for a different allocation.',
          );
        }

        return {
          commandId: existing.id,
          status: 'accepted' as const,
          campaignId: existing.campaignId ?? input.campaignId,
          replayed: true,
        };
      }

      const command = await tx.treasuryCommand.create({
        data: {
          kind: 'ALLOCATE_BUDGET',
          idempotencyKey: input.idempotencyKey,
          organizationId: input.organizationId,
          workspaceId: campaign.workspaceId,
          campaignId: input.campaignId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          actorUserId: input.actorUserId,
          actorMemberId: member.id,
          // Recorded, not acted on. The API has no way to check it — its role
          // holds no grants on the ledger schema — so it travels to the worker.
          expectedAvailableMinor: input.expectedAvailableMinor ?? null,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        select: { id: true },
      });

      // The Postgres-backed money queue is enqueued HERE, inside `tx`. BullMQ
      // handles everything that can afford at-least-once — email, notifications,
      // media — but it lives in Redis and cannot participate in this transaction.
      //
      // pg_notify inside a transaction is itself transactional: the notification
      // is delivered at COMMIT and never if the transaction aborts.
      await tx.$executeRaw`
        SELECT pg_notify('treasury_command', ${command.id}::text)
      `;

      return {
        commandId: command.id,
        status: 'accepted' as const,
        campaignId: input.campaignId,
        replayed: false,
      };
    });
  }
}
