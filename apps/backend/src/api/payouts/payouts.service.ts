import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * The creator's money.
 *
 * **Every query here is scoped by the session's user id in the WHERE clause.**
 * There is no creator id in any of these paths and there must never be one: the
 * authentication guard only says you are signed in, it cannot know whether a row
 * is yours.
 *
 * This is the most dangerous surface in the product for the population it
 * serves. Creators are passwordless, often have no second factor, and their
 * entire permission set is "be paid" — so a hijacked session is not "an
 * authenticated session and nothing more", it is a session that can redirect
 * somebody's income. Three consequences run through the file:
 *
 * **Rayi never accepts bank details.** There is no parameter here that takes an
 * account number. Binding a destination returns a link to the payment
 * provider's own onboarding, so the provider's identity checks are the second
 * factor.
 *
 * **Every change starts a hold**, notified to the OLD contact details. US
 * carriers reassign numbers after about 45 days, so a dormant creator's phone is
 * a standing risk and the hold is what makes a SIM swap recoverable instead of
 * final.
 *
 * **A blocked payout says why, in the creator's words.** A status code is a
 * support ticket at exactly the moment support cannot distinguish the creator
 * from whoever changed their details.
 */

/** Hours payouts are paused after a destination change. */
export const PAYOUT_HOLD_HOURS = 72;

/** How long a provider onboarding link is good for. Short, and single-use. */
const ONBOARDING_LINK_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  async listMine(userId: string) {
    const payouts = await this.prisma.payout.findMany({
      // Scoped by the SESSION user, in the WHERE clause. Not a parameter.
      where: { userId },
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        state: true,
        batchId: true,
        expectedArrivalAt: true,
        paidAt: true,
        reason: true,
        sources: {
          select: {
            dealId: true,
            brandName: true,
            milestoneTitle: true,
            amountMinor: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    // Released and waiting for the next run. Real money, not yet moved — and
    // deliberately NOT summed together with anything merely approved.
    const awaitingMinor = payouts
      .filter((payout) => payout.state === 'scheduled')
      .reduce((sum, payout) => sum + payout.amountMinor, 0n);

    const nextRunAt = payouts
      .filter((payout) => payout.state === 'scheduled' && payout.expectedArrivalAt)
      .map((payout) => payout.expectedArrivalAt!)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    return {
      payouts,
      awaitingMinor,
      currency: payouts[0]?.currency ?? 'USD',
      nextRunAt: nextRunAt ?? null,
    };
  }

  async destination(userId: string) {
    const destination = await this.prisma.payoutDestination.findUnique({
      where: { userId },
      select: {
        bankName: true,
        last4: true,
        payoutsEnabled: true,
        pendingRequirements: true,
        holdUntil: true,
        lastChangedAt: true,
      },
    });

    if (!destination) {
      /*
       * No row means NOT SET UP, never "enabled".
       *
       * Defaulting the other way would tell a creator they are ready to be paid
       * when they are not, which is the worst available lie on this screen.
       */
      return {
        bankName: null,
        last4: null,
        payoutsEnabled: false,
        pendingRequirements: ['Set up your payout details'],
        holdUntil: null,
        lastChangedAt: null,
      };
    }

    return {
      bankName: destination.bankName,
      last4: destination.last4,
      payoutsEnabled: destination.payoutsEnabled,
      pendingRequirements: Array.isArray(destination.pendingRequirements)
        ? (destination.pendingRequirements as string[])
        : [],
      holdUntil: destination.holdUntil,
      lastChangedAt: destination.lastChangedAt,
    };
  }

  /**
   * Begin changing where the money goes.
   *
   * Returns a link, not a form. The actual bank details are entered with the
   * payment provider and never reach Rayi, which is what makes the provider's
   * identity checks the second factor rather than a checkbox we control.
   *
   * The hold is applied when the provider tells us the destination ACTUALLY
   * changed — via `account.updated` — not here. Starting a change and
   * abandoning it must not pause somebody's income.
   */
  async startDestinationChange(
    userId: string,
    code: string,
    context: RequestContext,
    connectOnboardingUrl: string | null,
  ) {
    // Bound to this user, so a grant minted for one account cannot rebind
    // another. Single-use and consumed atomically.
    const resourceHash = StepUpService.resourceHash({
      userId,
      purpose: 'payout_destination',
    });
    await this.stepUp.mint({
      userId,
      purpose: StepUpPurpose.ChangePayoutDestination,
      code,
      resourceHash,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    await this.stepUp.consume({
      userId,
      purpose: StepUpPurpose.ChangePayoutDestination,
      resourceHash,
    });

    if (!connectOnboardingUrl) {
      // Refused rather than faked. A screen that says "continue" and goes
      // nowhere is worse than one that says the feature is not connected yet.
      throw new ServiceUnavailableException(
        'Payout setup is not available yet. Nothing has changed about your account.',
      );
    }

    const expiresAt = new Date(Date.now() + ONBOARDING_LINK_TTL_MS);

    await this.audit.record({
      action: AuditAction.PayoutDestinationChangeStarted,
      actorUserId: userId,
      subjectType: 'payout_destination',
      subjectId: userId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { holdHours: PAYOUT_HOLD_HOURS },
    });

    return { onboardingUrl: connectOnboardingUrl, expiresAt, holdHours: PAYOUT_HOLD_HOURS };
  }

  /**
   * Apply the hold, on the provider's signal that the destination changed.
   *
   * Called from the webhook path, never from a request. `account.updated` with
   * changed external accounts is the ONLY signal Rayi gets that somebody's bank
   * details moved, and a hold is what turns that notification into a recovery
   * window.
   */
  async applyDestinationHold(userId: string, now: Date = new Date()): Promise<Date> {
    const holdUntil = new Date(now.getTime() + PAYOUT_HOLD_HOURS * 3600_000);

    await this.prisma.$transaction(async (tx) => {
      await tx.payoutDestination.update({
        where: { userId },
        data: { holdUntil, lastChangedAt: now },
      });

      // Scheduled money is paused, with a reason written for the creator. A
      // held payout with no reason is a support ticket by construction — and
      // the database CHECK refuses one anyway.
      await tx.payout.updateMany({
        where: { userId, state: 'scheduled' },
        data: {
          state: 'held',
          reason:
            `Paused until ${holdUntil.toISOString().slice(0, 10)} because your bank details ` +
            `changed. If that was not you, use the stop link in the email we sent to your ` +
            `previous address — it undoes the change.`,
        },
      });
    });

    return holdUntil;
  }

  async profile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        firstName: true,
        lastName: true,
        bio: true,
        image: true,
        email: true,
        twoFactorEnabled: true,
      },
    });
    if (!user) {
      // A signed-in session whose user no longer exists. Treated as
      // unauthenticated rather than as an empty profile.
      throw new ServiceUnavailableException('Sign in again to continue.');
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
    return {
      handle: `@${user.username}`,
      displayName: name.length > 0 ? name : null,
      bio: user.bio,
      avatarUrl: user.image,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
      publicUrl: null as string | null,
    };
  }
}
