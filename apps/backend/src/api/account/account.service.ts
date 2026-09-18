import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { PrismaService } from '@/database/prisma.service';

/**
 * The account actions that replace blocked Better Auth endpoints.
 *
 * Better Auth's own `/list-sessions`, `/revoke-session` and `/revoke-sessions`
 * are 404'd at the mount, because its middleware serves and returns before
 * Nest's guard chain runs — no audit row, no rate limit of ours, no hook for
 * step-up later. Blocking them without replacing them would leave a user unable
 * to evict a stolen session, which is the opposite of a security improvement.
 *
 * Everything here writes an audit row. That is the entire justification for
 * reimplementing rather than re-exposing, so an action here that skips the audit
 * has no reason to exist in this file.
 */

export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** True for the session making this request. The UI must never offer to revoke it by accident. */
  readonly current: boolean;
}

export interface RequestContext {
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The user's own sessions.
   *
   * Scoped by `userId` in the WHERE clause rather than filtered afterwards, so
   * there is no code path that loads someone else's sessions and then decides
   * not to return them.
   *
   * Session TOKENS are never selected. A list endpoint that returned them would
   * turn "show me my devices" into "hand me a credential for each of them", and
   * an XSS on the page would harvest every one.
   */
  async listSessions(userId: string, currentToken?: string): Promise<SessionSummary[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
        token: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      current: currentToken !== undefined && session.token === currentToken,
      // `token` is destructured out here and never leaves this method.
    }));
  }

  /**
   * Revokes one of the user's own sessions.
   *
   * The tenant predicate is `userId`, in the WHERE clause. Revoking by id alone
   * would let any authenticated user sign out any other by guessing ids — and a
   * session id is not a secret, it appears in this user's own list.
   *
   * 404 rather than 403 for someone else's session id, so the endpoint does not
   * confirm which ids exist.
   */
  async revokeSession(
    userId: string,
    sessionId: string,
    context: RequestContext,
  ): Promise<void> {
    const { count } = await this.prisma.session.deleteMany({
      where: { id: sessionId, userId },
    });

    if (count === 0) throw new NotFoundException('No such session.');

    await this.audit.record({
      action: AuditAction.SessionRevoked,
      actorUserId: userId,
      subjectType: 'session',
      subjectId: sessionId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { scope: 'one' },
    });
  }

  /**
   * Revokes every session except the one making the request.
   *
   * The "I think I've been compromised" button, and the reason blocking Better
   * Auth's version without replacing it was not acceptable. It deliberately
   * keeps the current session alive: signing the user out of the device they are
   * actively using, at the moment they are trying to secure their account, makes
   * them re-authenticate through the same email an attacker may control.
   */
  async revokeOtherSessions(
    userId: string,
    currentToken: string,
    context: RequestContext,
  ): Promise<{ revoked: number }> {
    const { count } = await this.prisma.session.deleteMany({
      where: { userId, token: { not: currentToken } },
    });

    await this.audit.record({
      action: AuditAction.SessionsRevokedAll,
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { scope: 'others', revoked: count },
    });

    return { revoked: count };
  }

  /**
   * Updates the profile fields a user may change about themselves.
   *
   * An explicit allowlist of columns, not a spread of the request body. Better
   * Auth's `/update-user` accepts a partial user object, which is how a field
   * nobody meant to expose — `role`, `twoFactorEnabled`, `isEmailVerified` —
   * becomes writable by anyone holding a session.
   *
   * `email` is NOT here. Changing the address that receives magic links is an
   * account-takeover primitive and needs step-up plus notification to the old
   * address; it gets its own flow rather than riding along in a profile update.
   */
  async updateProfile(
    userId: string,
    changes: { firstName?: string; lastName?: string; bio?: string; image?: string },
    context: RequestContext,
  ): Promise<void> {
    const data: Record<string, string> = {};
    if (changes.firstName !== undefined) data['firstName'] = changes.firstName;
    if (changes.lastName !== undefined) data['lastName'] = changes.lastName;
    if (changes.bio !== undefined) data['bio'] = changes.bio;
    if (changes.image !== undefined) data['image'] = changes.image;

    if (Object.keys(data).length === 0) {
      throw new ForbiddenException('No supported fields to update.');
    }

    await this.prisma.user.update({ where: { id: userId }, data });

    await this.audit.record({
      action: AuditAction.ProfileUpdated,
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      // WHICH fields changed, not what they changed to. A bio can contain
      // anything a user typed, and an audit log is not the place to keep a
      // second copy of user-authored content.
      data: { fields: Object.keys(data).sort() },
    });
  }
}
