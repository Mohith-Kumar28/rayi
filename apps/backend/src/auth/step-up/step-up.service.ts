import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { PrismaService } from '@/database/prisma.service';

import { verifyTotp } from './totp';

/**
 * Step-up authentication.
 *
 * Proves that the person at the keyboard *right now* holds the second factor,
 * before an action that could take over an account or move money. A session
 * cannot prove that: it was established once, possibly days ago, possibly on a
 * device that is no longer in the user's hands.
 *
 * Three properties, and each exists because its absence has been a real
 * vulnerability somewhere:
 *
 *   **Bound to a purpose.** A grant minted to change an email cannot remove a
 *   second factor. One purpose per grant, checked on consume.
 *
 *   **Bound to the resource.** The grant carries a hash of the exact thing being
 *   confirmed. Without it, confirming "$10 to campaign A" authorises "$10,000 to
 *   campaign B" for as long as the grant lives — which is precisely the
 *   bulk-approve hole the money-integrity review found.
 *
 *   **Single use, and consumed atomically.** A grant that can be spent twice is
 *   a grant that can be spent on something the user never saw. The decrement is
 *   a conditional `updateMany`, so two concurrent requests cannot both win.
 */

/** How long a grant lives. Long enough to finish a form, short enough to matter. */
const GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Failed attempts before step-up is refused for a while.
 *
 * A six-digit code has a million values and the drift window makes three of them
 * valid at any moment, so unlimited guessing finds one in expectation after
 * ~330k tries. That is minutes at HTTP speeds.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export const StepUpPurpose = {
  ChangeEmail: 'account:change_email',
  DisableTwoFactor: 'account:disable_two_factor',
  EnableTwoFactor: 'account:enable_two_factor',
  ChangeMemberRole: 'member:change_role',
  RemoveMember: 'member:remove',
  GrantMoneyAuthority: 'money_authority:grant',
  ReleaseFunds: 'funds:release',
} as const;

export type StepUpPurpose = (typeof StepUpPurpose)[keyof typeof StepUpPurpose];

export class StepUpRequiredError extends UnauthorizedException {
  constructor(readonly purpose: string) {
    super({
      code: 'step_up_required',
      message: 'Confirm with your authenticator app to continue.',
      purpose,
    });
  }
}

@Injectable()
export class StepUpService {
  private readonly logger = new Logger(StepUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A stable hash of what is being confirmed.
   *
   * The UI shows the user a specific thing; this is what binds the grant to
   * exactly that thing. Callers must build it from the SAME values the user was
   * shown — an amount taken from elsewhere makes the binding meaningless.
   *
   * Keys are sorted so the hash does not depend on object literal order, which
   * would otherwise make an identical request fail to match its own grant.
   */
  static resourceHash(
    parts: Record<string, string | number | bigint | null>,
  ): string {
    const canonical = Object.keys(parts)
      .sort()
      .map((key) => `${key}=${String(parts[key])}`)
      .join('');
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Verifies a TOTP code and mints a grant.
   *
   * Throws rather than returning a failure, because every caller's correct
   * response to "the code was wrong" is identical and a boolean invites a caller
   * to forget to check it.
   */
  async mint(input: {
    userId: string;
    purpose: StepUpPurpose;
    code: string;
    resourceHash?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<{ grantId: string; expiresAt: Date }> {
    await this.assertNotRateLimited(input.userId);

    const factor = await this.prisma.twoFactor.findFirst({
      where: { userId: input.userId, deletedAt: null, secret: { not: null } },
      select: { secret: true },
    });

    if (!factor?.secret) {
      // No second factor enrolled. Refused rather than waved through: a step-up
      // that succeeds without a factor is not a step-up, and "the user has not
      // set one up yet" is exactly when an attacker would like it skipped.
      throw new ForbiddenException(
        'This action needs a second factor. Add an authenticator app first.',
      );
    }

    if (!verifyTotp({ secret: factor.secret, code: input.code })) {
      await this.recordFailure(input.userId, input.purpose, input.ipAddress);
      throw new StepUpRequiredError(input.purpose);
    }

    const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
    const grant = await this.prisma.stepUpGrant.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        resourceHash: input.resourceHash ?? null,
        expiresAt,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });

    return { grantId: grant.id, expiresAt };
  }

  /**
   * Spends a grant, or throws.
   *
   * Atomic: the decrement is a conditional `updateMany` whose WHERE clause
   * carries every condition — user, purpose, resource, not expired, uses
   * remaining. Two concurrent requests cannot both succeed, because only one can
   * see `usesRemaining: 1`.
   *
   * Loading the grant and then checking it in application code would leave a
   * window between the check and the spend, and that window is the whole
   * vulnerability.
   */
  async consume(input: {
    userId: string;
    purpose: StepUpPurpose;
    resourceHash?: string | undefined;
  }): Promise<void> {
    const { count } = await this.prisma.stepUpGrant.updateMany({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        // `null` is a real value here, not "any". A purpose with parameters must
        // never be satisfied by an unbound grant.
        resourceHash: input.resourceHash ?? null,
        usesRemaining: { gt: 0 },
        expiresAt: { gt: new Date() },
        consumedAt: null,
      },
      data: { usesRemaining: { decrement: 1 }, consumedAt: new Date() },
    });

    if (count === 0) {
      throw new StepUpRequiredError(input.purpose);
    }
  }

  /**
   * Whether a usable grant exists, without spending it.
   *
   * For rendering only — so the UI can skip the confirmation dialog it would
   * otherwise show. **Never** as the authorization check: between this returning
   * true and the action running, the grant can expire or be spent elsewhere.
   * `consume` is the check.
   */
  async has(input: {
    userId: string;
    purpose: StepUpPurpose;
    resourceHash?: string | undefined;
  }): Promise<boolean> {
    const grant = await this.prisma.stepUpGrant.findFirst({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        resourceHash: input.resourceHash ?? null,
        usesRemaining: { gt: 0 },
        expiresAt: { gt: new Date() },
        consumedAt: null,
      },
      select: { id: true },
    });
    return grant !== null;
  }

  /**
   * Refuses further attempts after repeated failures.
   *
   * A six-digit code with a one-step drift window has three valid values out of
   * a million at any moment. Unlimited guessing finds one in minutes at HTTP
   * speeds, so the rate limit is not hardening — it is the difference between a
   * second factor and a delay.
   *
   * Counted from the audit log rather than a separate table: the failures have to
   * be recorded anyway, and one source means the count cannot disagree with the
   * history.
   */
  private async assertNotRateLimited(userId: string): Promise<void> {
    const since = new Date(Date.now() - ATTEMPT_WINDOW_MS);
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
        FROM audit.event
       WHERE action = 'account.step_up_failed'
         AND actor_user_id = ${userId}
         AND occurred_at > ${since}
    `;

    if ((rows[0]?.count ?? 0n) >= BigInt(MAX_ATTEMPTS)) {
      this.logger.warn(`Step-up rate limit reached for ${userId}.`);
      throw new ForbiddenException(
        'Too many incorrect codes. Wait a few minutes before trying again.',
      );
    }
  }

  private async recordFailure(
    userId: string,
    purpose: string,
    ipAddress: string | undefined,
  ): Promise<void> {
    this.logger.warn(`Step-up failed for ${userId} on ${purpose}.`);
    await this.audit.record({
      action: AuditAction.StepUpFailed,
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      ipAddress: ipAddress ?? null,
      data: { purpose },
    });
  }
}
