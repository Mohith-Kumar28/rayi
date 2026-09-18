import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import { encodeBase32, otpauthUri, verifyTotp } from '@/auth/step-up/totp';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * The security-sensitive account actions, replacing the Better Auth endpoints
 * blocked at the mount.
 *
 * All of these are account-takeover primitives, which is why Better Auth's
 * versions — reachable with nothing but a session cookie, with no MFA, no audit
 * row and no rate limit of ours — are 404'd.
 */

/** How long a confirmation link lives. Long enough to find the email, short enough to matter. */
const EMAIL_CHANGE_TTL_MS = 30 * 60 * 1000;

/**
 * How long an unconfirmed enrolment survives.
 *
 * Long enough to install an authenticator app mid-flow, short enough that an
 * abandoned secret does not sit around indefinitely.
 */
const ENROLMENT_TTL_MS = 15 * 60 * 1000;

/** Wrong codes allowed against one enrolment before it is thrown away. */
const ENROLMENT_MAX_ATTEMPTS = 10;

/** RFC 4226 recommends at least 128 bits; 160 is what every authenticator expects. */
const SECRET_BYTES = 20;

const BACKUP_CODE_COUNT = 10;

@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Starts an email change.
   *
   * Two-sided, and both sides are load-bearing:
   *
   *   The **step-up** proves the person asking holds the second factor. Without
   *   it, a stolen session changes the address that receives every future magic
   *   link — which is the account.
   *
   *   The **confirmation at the new address** proves they can actually receive
   *   mail there. Without it, a typo locks someone out of their own account
   *   permanently, and the failure is invisible until they next try to sign in.
   *
   * The OLD address is notified NOW, not on completion. Whoever holds it today is
   * the person who needs to hear about this while there is still time to object.
   */
  async requestEmailChange(input: {
    userId: string;
    newEmail: string;
    code: string;
    context: RequestContext;
  }): Promise<{ token: string; oldEmail: string; newEmail: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true },
    });

    const newEmail = input.newEmail.trim().toLowerCase();

    if (newEmail === user.email.toLowerCase()) {
      throw new ConflictException('That is already your email address.');
    }

    // The step-up is bound to THIS address. A grant minted to move the account
    // to an address the user chose must not be spendable on a different one —
    // otherwise the confirmation dialog showed one thing and authorised another.
    const resourceHash = StepUpService.resourceHash({ newEmail });

    await this.stepUp.mint({
      userId: input.userId,
      purpose: StepUpPurpose.ChangeEmail,
      code: input.code,
      resourceHash,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
    });
    await this.stepUp.consume({
      userId: input.userId,
      purpose: StepUpPurpose.ChangeEmail,
      resourceHash,
    });

    // Checked AFTER the step-up, deliberately. Checking first would make this
    // endpoint an account-existence oracle for anyone holding any session.
    const taken = await this.prisma.user.findFirst({
      where: { email: newEmail, deletedAt: null },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('That address cannot be used.');
    }

    // The token is returned to the caller for emailing and NEVER stored. A
    // database read would otherwise hand over a working takeover link.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Any earlier pending request is cancelled. Two live confirmation links mean
    // two addresses that could become the account, and only one of them is the
    // one the user last chose.
    await this.prisma.emailChangeRequest.updateMany({
      where: { userId: input.userId, confirmedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });

    await this.prisma.emailChangeRequest.create({
      data: {
        userId: input.userId,
        oldEmail: user.email,
        newEmail,
        tokenHash,
        expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
      },
    });

    await this.audit.record({
      action: AuditAction.EmailChangeRequested,
      actorUserId: input.userId,
      subjectType: 'user',
      subjectId: input.userId,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
      // Both addresses, because the whole point of this record is answering
      // "what was it before" after the user row has already changed.
      data: { from: user.email, to: newEmail },
    });

    return { token, oldEmail: user.email, newEmail };
  }

  /**
   * Completes an email change from the confirmation link.
   *
   * Looks the request up by the token's HASH, so a stolen database row is not a
   * usable link. Single-use and time-bounded, both enforced in the WHERE clause
   * rather than checked afterwards.
   */
  async confirmEmailChange(
    token: string,
    context: RequestContext,
  ): Promise<{ email: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const request = await this.prisma.emailChangeRequest.findFirst({
      where: {
        tokenHash,
        confirmedAt: null,
        cancelledAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!request) {
      // One message for expired, already-used, cancelled and never-existed. Each
      // distinction would tell a holder of a stale link something about the
      // account.
      throw new ForbiddenException('That link is no longer valid.');
    }

    // The address could have been claimed between request and confirmation.
    const taken = await this.prisma.user.findFirst({
      where: { email: request.newEmail, deletedAt: null },
      select: { id: true },
    });
    if (taken) throw new ConflictException('That address cannot be used.');

    await this.prisma.$transaction(async (tx) => {
      // Guarded on `confirmedAt: null` so two clicks of the same link cannot both
      // apply — the second changes nothing.
      const { count } = await tx.emailChangeRequest.updateMany({
        where: { id: request.id, confirmedAt: null },
        data: { confirmedAt: new Date() },
      });
      if (count === 0)
        throw new ForbiddenException('That link is no longer valid.');

      await tx.user.update({
        where: { id: request.userId },
        // `isEmailVerified` stays true: following this link IS the verification,
        // and flipping it false would lock the user out of an account they just
        // proved they control.
        data: { email: request.newEmail },
      });

      // Every other session is ended. If this change was an attacker's, the
      // session they were using dies with it; if it was the user's, signing in
      // again on their other devices costs them one magic link.
      await tx.session.deleteMany({ where: { userId: request.userId } });
    });

    await this.audit.record({
      action: AuditAction.EmailChanged,
      actorUserId: request.userId,
      subjectType: 'user',
      subjectId: request.userId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      data: { from: request.oldEmail, to: request.newEmail },
    });

    return { email: request.newEmail };
  }

  /**
   * Cancels a pending change, from the link in the notification to the OLD
   * address.
   *
   * This is the point of notifying them. A notification that only says "this
   * happened" leaves the real owner watching their account being taken with
   * nothing to press.
   *
   * No authentication: the person receiving it may already be locked out, and
   * requiring a sign-in would make the escape hatch useless exactly when it
   * matters. The token is the authorisation, and cancelling is safe — the worst
   * outcome is a legitimate change that has to be started again.
   */
  async cancelEmailChange(
    token: string,
    context: RequestContext,
  ): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const { count } = await this.prisma.emailChangeRequest.updateMany({
      where: { tokenHash, confirmedAt: null, cancelledAt: null },
      data: { cancelledAt: new Date() },
    });

    if (count === 0) {
      throw new ForbiddenException('That link is no longer valid.');
    }

    const request = await this.prisma.emailChangeRequest.findFirst({
      where: { tokenHash },
      select: { userId: true, newEmail: true },
    });

    if (request) {
      await this.audit.record({
        action: AuditAction.EmailChangeCancelled,
        actorUserId: request.userId,
        subjectType: 'user',
        subjectId: request.userId,
        ipAddress: context.ipAddress ?? null,
        data: { attemptedTo: request.newEmail, via: 'cancel_link' },
      });
      this.logger.warn(
        `Email change cancelled for ${request.userId} via the old-address link.`,
      );
    }
  }

  /**
   * Removes the second factor.
   *
   * Requires a code FROM THE FACTOR BEING REMOVED, so holding the session is not
   * enough. Better Auth's `/two-factor/disable` accepts a session alone, which
   * makes it the single worst endpoint in its default surface: a stolen session
   * removes the control that would have stopped the theft mattering.
   */
  async disableTwoFactor(input: {
    userId: string;
    code: string;
    context: RequestContext;
  }): Promise<void> {
    await this.stepUp.mint({
      userId: input.userId,
      purpose: StepUpPurpose.DisableTwoFactor,
      code: input.code,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
    });
    await this.stepUp.consume({
      userId: input.userId,
      purpose: StepUpPurpose.DisableTwoFactor,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.twoFactor.deleteMany({ where: { userId: input.userId } });
      await tx.user.update({
        where: { id: input.userId },
        data: { twoFactorEnabled: false },
      });
    });

    await this.audit.record({
      action: AuditAction.TwoFactorDisabled,
      actorUserId: input.userId,
      subjectType: 'user',
      subjectId: input.userId,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
    });

    this.logger.warn(`Two-factor removed for ${input.userId}.`);
  }

  /**
   * Starts enrolling a second factor.
   *
   * Writes to a SEPARATE table, not the live one. If enrolment wrote straight to
   * `TwoFactor`, a user who scanned the QR into the wrong entry — or whose phone
   * clock is wrong — would be locked out of their own account by the act of
   * trying to secure it, with no way back in.
   *
   * Replacing an EXISTING factor needs a code from the current one, because
   * swapping a factor is exactly as sensitive as removing one: an attacker with
   * a session would otherwise enrol their own and own the account.
   */
  async beginTwoFactorEnrolment(input: {
    userId: string;
    issuer: string;
    /** Required only when a factor already exists. */
    currentCode?: string | undefined;
    context: RequestContext;
  }): Promise<{ secret: string; otpauthUri: string; expiresAt: Date }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { email: true },
    });

    const existing = await this.prisma.twoFactor.findFirst({
      where: { userId: input.userId, deletedAt: null, secret: { not: null } },
      select: { id: true },
    });

    if (existing) {
      if (!input.currentCode) throw new ForbiddenException('Confirm with your current code first.');
      await this.stepUp.mint({
        userId: input.userId,
        purpose: StepUpPurpose.EnableTwoFactor,
        code: input.currentCode,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
      });
      await this.stepUp.consume({
        userId: input.userId,
        purpose: StepUpPurpose.EnableTwoFactor,
      });
    }

    const secret = encodeBase32(randomBytes(SECRET_BYTES));
    const expiresAt = new Date(Date.now() + ENROLMENT_TTL_MS);

    // One live enrolment per user. Starting again replaces the previous secret
    // rather than leaving two that could each be confirmed.
    await this.prisma.twoFactorEnrolment.upsert({
      where: { userId: input.userId },
      create: { userId: input.userId, secret, expiresAt },
      update: { secret, expiresAt, attempts: 0 },
    });

    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer: input.issuer }),
      expiresAt,
    };
  }

  /**
   * Confirms an enrolment with a code from the newly-scanned secret.
   *
   * This is the proof that the factor actually works — that the secret was
   * transcribed correctly and that the phone's clock agrees with ours. Only now
   * does it become live.
   *
   * Returns backup codes, shown ONCE. A user who loses their phone with no
   * recovery path has lost the account, and support cannot help without becoming
   * the account-recovery vulnerability themselves.
   */
  async confirmTwoFactorEnrolment(input: {
    userId: string;
    code: string;
    context: RequestContext;
  }): Promise<{ backupCodes: string[] }> {
    const enrolment = await this.prisma.twoFactorEnrolment.findFirst({
      where: { userId: input.userId, expiresAt: { gt: new Date() } },
    });

    if (!enrolment) {
      throw new ForbiddenException('Start setting up your authenticator app again.');
    }

    if (enrolment.attempts >= ENROLMENT_MAX_ATTEMPTS) {
      await this.prisma.twoFactorEnrolment.deleteMany({ where: { userId: input.userId } });
      throw new ForbiddenException('Too many incorrect codes. Start again.');
    }

    if (!verifyTotp({ secret: enrolment.secret, code: input.code })) {
      await this.prisma.twoFactorEnrolment.update({
        where: { id: enrolment.id },
        data: { attempts: { increment: 1 } },
      });
      throw new ForbiddenException('That code did not match. Check the app and try again.');
    }

    const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => generateBackupCode());

    await this.prisma.$transaction(async (tx) => {
      // Replacing rather than adding. A user who re-enrols has one factor, not
      // two — and a stale secret that still verifies is a second key to the
      // account that nobody is holding on purpose.
      await tx.twoFactor.deleteMany({ where: { userId: input.userId } });
      await tx.twoFactorBackupCode.deleteMany({ where: { userId: input.userId } });

      await tx.twoFactor.create({ data: { userId: input.userId, secret: enrolment.secret } });
      await tx.twoFactorBackupCode.createMany({
        data: backupCodes.map((code) => ({
          userId: input.userId,
          codeHash: createHash('sha256').update(code).digest('hex'),
        })),
      });
      await tx.user.update({ where: { id: input.userId }, data: { twoFactorEnabled: true } });
      await tx.twoFactorEnrolment.deleteMany({ where: { userId: input.userId } });
    });

    await this.audit.record({
      action: AuditAction.TwoFactorEnabled,
      actorUserId: input.userId,
      subjectType: 'user',
      subjectId: input.userId,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
      // The COUNT, never the codes. An audit log holding working recovery codes
      // is an audit log that is also a credential store.
      data: { backupCodesIssued: backupCodes.length },
    });

    return { backupCodes };
  }
}

/**
 * A recovery code: ten crypto-random digits, grouped for transcription.
 *
 * `randomInt` rather than `Math.random`, because a predictable recovery code is
 * a predictable way into every account that holds one.
 *
 * Digits rather than letters so there is no 0/O or 1/l to misread when someone
 * is copying these off a screen under pressure — which is the only circumstance
 * in which they are ever used.
 */
function generateBackupCode(): string {
  const digits = Array.from({ length: 10 }, () => randomInt(0, 10)).join('');
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}
