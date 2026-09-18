import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import { PermissionService } from '@/authorization/permission.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * Membership, reimplemented.
 *
 * Better Auth's `/organization/*` endpoints are blocked at the mount because its
 * middleware serves and returns BEFORE Nest's guard chain: no MFA, no step-up,
 * no audit row, and no coverage from any route test, because they are not Nest
 * routes. `/organization/update-member-role` in particular was a privilege
 * change reachable with nothing but a session cookie.
 *
 * Two rules run through everything here:
 *
 *   **An invitation can only ever produce a ROLE.** Money capability is a
 *   separate `MoneyAuthority` row that nothing in this file creates. That is
 *   what deletes the escalation the review found — invite a mailbox you control
 *   at a money-bearing role — rather than patching the places it could be used.
 *
 *   **Losing a role means losing the sessions that carried it.** A downgrade
 *   that leaves a live session is a role still held until that session expires,
 *   which can be days.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string) {
    const members = await this.prisma.member.findMany({
      where: { organizationId },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true } },
        // Surfaced so an admin reviewing the list can SEE who is trusted with
        // funds. Money capability that is invisible in the members list is money
        // capability nobody audits.
        moneyAuthorities: {
          where: { revokedAt: null },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((member) => ({
      memberId: member.id,
      userId: member.userId,
      email: member.user.email,
      role: member.role,
      createdAt: member.createdAt,
      hasMoneyAuthority: member.moneyAuthorities.length > 0,
    }));
  }

  /**
   * Invites someone at a role.
   *
   * The role is checked against a CEILING: nobody may invite above their own
   * level. Better Auth enforces no such ceiling — its docs say plainly that
   * "there's no built-in restriction preventing an admin from inviting someone
   * as owner" — which is a one-step self-promotion for any admin willing to use
   * a second mailbox.
   */
  async invite(input: {
    organizationId: string;
    actorUserId: string;
    email: string;
    role: string;
    context: RequestContext;
  }): Promise<{ invitationId: string; token: string }> {
    const email = input.email.trim().toLowerCase();

    const actor = await this.prisma.member.findFirst({
      where: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
      },
      select: { id: true, role: true },
    });
    if (!actor) throw new NotFoundException('Not found.');

    this.assertCanGrantRole(actor.role, input.role);

    const existing = await this.prisma.member.findFirst({
      where: { organizationId: input.organizationId, user: { email } },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException(
        'That person is already in this organization.',
      );

    // Supersede any live invitation for the same address. Two open invitations
    // at different roles mean whichever is accepted decides the role, which is
    // not a decision anyone made.
    await this.prisma.invitation.updateMany({
      where: {
        organizationId: input.organizationId,
        email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        invitedBy: input.actorUserId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true },
    });

    await this.audit.record({
      action: AuditAction.MemberInvited,
      actorUserId: input.actorUserId,
      actorMemberId: actor.id,
      organizationId: input.organizationId,
      subjectType: 'invitation',
      subjectId: invitation.id,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
      data: { email, role: input.role },
    });

    return { invitationId: invitation.id, token };
  }

  /**
   * Changes a member's role.
   *
   * Step-up is bound to THIS member and THIS role, so a confirmation the user
   * saw for one change cannot authorise another — the bulk-approve lesson,
   * applied to privilege instead of money.
   */
  async changeRole(input: {
    organizationId: string;
    memberId: string;
    actorUserId: string;
    role: string;
    code: string;
    context: RequestContext;
  }): Promise<{ memberId: string; role: string }> {
    const actor = await this.prisma.member.findFirst({
      where: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
      },
      select: { id: true, role: true },
    });
    if (!actor) throw new NotFoundException('Not found.');

    // The tenant predicate is in the WHERE clause, so a member of another
    // organization simply does not exist here.
    const target = await this.prisma.member.findFirst({
      where: { id: input.memberId, organizationId: input.organizationId },
      select: { id: true, role: true, userId: true },
    });
    if (!target) throw new NotFoundException('Not found.');

    if (target.userId === input.actorUserId) {
      // Self-promotion is the whole attack. Even a legitimate owner changing
      // their own role should go through another owner, so there is always a
      // second person in the record.
      throw new ForbiddenException('You cannot change your own role.');
    }

    this.assertCanGrantRole(actor.role, input.role);
    // And you cannot act on someone above you, or an admin demotes an owner and
    // then promotes themselves.
    this.assertCanGrantRole(actor.role, target.role);

    if (await this.isLastOwner(input.organizationId, target)) {
      // An organization with no owner is one nobody can administer, fund or
      // close — an unrecoverable state reachable by an ordinary mistake.
      throw new ConflictException(
        'An organization must keep at least one owner.',
      );
    }

    const resourceHash = StepUpService.resourceHash({
      memberId: target.id,
      role: input.role,
      organizationId: input.organizationId,
    });

    await this.stepUp.mint({
      userId: input.actorUserId,
      purpose: StepUpPurpose.ChangeMemberRole,
      code: input.code,
      resourceHash,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
    });
    await this.stepUp.consume({
      userId: input.actorUserId,
      purpose: StepUpPurpose.ChangeMemberRole,
      resourceHash,
    });

    const downgrade = RANK[input.role]! < RANK[target.role]!;

    await this.prisma.$transaction(async (tx) => {
      await tx.member.update({
        where: { id: target.id },
        data: { role: input.role },
      });

      if (downgrade) {
        // A role taken away that leaves a live session is a role still held —
        // for as long as that session lasts, which can be days.
        await tx.session.deleteMany({ where: { userId: target.userId } });
        // And money capability does not survive a demotion. It is granted
        // separately, so it has to be revoked separately too; leaving it would
        // mean a demoted member who can still move funds.
        await tx.moneyAuthority.updateMany({
          where: { memberId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    });

    await this.audit.record({
      action: AuditAction.MemberRoleChanged,
      actorUserId: input.actorUserId,
      actorMemberId: actor.id,
      organizationId: input.organizationId,
      subjectType: 'member',
      subjectId: target.id,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
      data: { from: target.role, to: input.role, downgrade },
    });

    return { memberId: target.id, role: input.role };
  }

  /** Removes a member, revoking everything that outlived the membership. */
  async remove(input: {
    organizationId: string;
    memberId: string;
    actorUserId: string;
    code: string;
    context: RequestContext;
  }): Promise<void> {
    const actor = await this.prisma.member.findFirst({
      where: {
        userId: input.actorUserId,
        organizationId: input.organizationId,
      },
      select: { id: true, role: true },
    });
    if (!actor) throw new NotFoundException('Not found.');

    const target = await this.prisma.member.findFirst({
      where: { id: input.memberId, organizationId: input.organizationId },
      select: { id: true, role: true, userId: true },
    });
    if (!target) throw new NotFoundException('Not found.');

    this.assertCanGrantRole(actor.role, target.role);

    if (await this.isLastOwner(input.organizationId, target)) {
      throw new ConflictException(
        'An organization must keep at least one owner.',
      );
    }

    const resourceHash = StepUpService.resourceHash({
      memberId: target.id,
      organizationId: input.organizationId,
    });

    await this.stepUp.mint({
      userId: input.actorUserId,
      purpose: StepUpPurpose.RemoveMember,
      code: input.code,
      resourceHash,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
    });
    await this.stepUp.consume({
      userId: input.actorUserId,
      purpose: StepUpPurpose.RemoveMember,
      resourceHash,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.moneyAuthority.updateMany({
        where: { memberId: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // The composite foreign keys cascade the workspace memberships, which is
      // why removal is a single delete rather than a list of cleanups someone
      // could get incomplete.
      await tx.member.delete({ where: { id: target.id } });
      await tx.session.deleteMany({ where: { userId: target.userId } });
    });

    await this.audit.record({
      action: AuditAction.MemberRemoved,
      actorUserId: input.actorUserId,
      actorMemberId: actor.id,
      organizationId: input.organizationId,
      subjectType: 'member',
      subjectId: target.id,
      requestId: input.context.requestId ?? null,
      ipAddress: input.context.ipAddress ?? null,
      userAgent: input.context.userAgent ?? null,
      data: { role: target.role },
    });

    this.logger.warn(
      `Member ${target.id} removed from ${input.organizationId}.`,
    );
  }

  /**
   * Nobody may grant a role above their own.
   *
   * Better Auth enforces no such ceiling — its own docs say "there's no built-in
   * restriction preventing an admin from inviting someone as owner", which makes
   * self-promotion a two-step move for any admin with a second mailbox.
   *
   * Comma-separated roles are split, because Better Auth stores them that way:
   * `role === 'owner'` is false for `'member,owner'`, and `role.includes('owner')`
   * is true for `'not-owner'`. Taking the HIGHEST of the split values is the only
   * reading that is safe in both directions.
   */
  private assertCanGrantRole(actorRole: string, targetRole: string): void {
    const actorRank = Math.max(
      ...actorRole
        .split(',')
        .map((role) => RANK[role.trim()] ?? -1)
        .concat(-1),
    );
    const targetRank = RANK[targetRole] ?? Number.POSITIVE_INFINITY;

    if (targetRank > actorRank) {
      throw new ForbiddenException('You cannot grant a role above your own.');
    }
  }

  /**
   * Would this leave the organization with no owner?
   *
   * An org with no owner is one nobody can administer, fund or close — an
   * unrecoverable state reachable by an ordinary mistake, so it is refused at the
   * only place that can see it.
   */
  private async isLastOwner(
    organizationId: string,
    target: { id: string; role: string },
  ): Promise<boolean> {
    if (!target.role.split(',').some((role) => role.trim() === 'owner'))
      return false;

    const owners = await this.prisma.member.count({
      where: { organizationId, role: { contains: 'owner' } },
    });
    return owners <= 1;
  }
}

/** Higher outranks lower. The only ordering in the system. */
const RANK: Record<string, number> = { member: 0, admin: 1, owner: 2 };
