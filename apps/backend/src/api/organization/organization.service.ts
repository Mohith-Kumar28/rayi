import { Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';

/**
 * The organization, and its unaccepted invitations.
 *
 * **The daily release ceiling is not a setting this surface can raise.** A
 * limit an account can lift is not a limit — a phished founder would simply
 * lift it. It is read here and changed through a conversation, which is the
 * whole point of it existing when no genuine second approver does.
 *
 * Invitations live here rather than with members because a pending invitation
 * is NOT a member. Treating it as one is how a list of "people" silently
 * includes mailboxes nobody has accepted from.
 */

/**
 * The default ceiling, in minor units.
 *
 * $10,000/day. Applies on organization risk signals rather than on self-declared
 * headcount: a ceiling a second account removes would punish honesty, since a
 * founder who declares solo mode would get a cap while an attacker with two
 * mailboxes gets none.
 */
const DEFAULT_DAILY_CEILING_MINOR = 1_000_000n;

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  async get(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, slug: true, createdAt: true },
    });
    if (!organization) throw new NotFoundException();

    // What has actually been released today, from the deal rows rather than the
    // ledger — the api role cannot read the ledger schema at all.
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const releasedToday = await this.prisma.milestone.findMany({
      where: {
        releasedAt: { gte: startOfDay },
        agreementVersion: { deal: { organizationId } },
      },
      select: { amountMinor: true },
    });

    return {
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      // Outbound-only, and never blocks ingestion: freezing the clearing path
      // would kill webhook processing during an incident and burn the
      // provider's retry window.
      frozen: false,
      dailyReleaseCeilingMinor: DEFAULT_DAILY_CEILING_MINOR,
      dailyReleasedMinor: releasedToday.reduce(
        (sum, milestone) => sum + milestone.amountMinor,
        0n,
      ),
      currency: 'USD',
      // No funding account is linked until the deposit flow exists. Reported as
      // absent rather than invented.
      bankAccountLast4: null as string | null,
      bankAccountStatus: 'none' as const,
    };
  }

  async update(
    organizationId: string,
    input: { name?: string | undefined; code: string },
    actorUserId: string,
    context: RequestContext,
  ) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    if (!organization) throw new NotFoundException();

    const resourceHash = StepUpService.resourceHash({
      organizationId,
      name: input.name ?? organization.name,
    });
    await this.stepUp.mint({
      userId: actorUserId,
      purpose: StepUpPurpose.UpdateOrganization,
      code: input.code,
      resourceHash,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    await this.stepUp.consume({
      userId: actorUserId,
      purpose: StepUpPurpose.UpdateOrganization,
      resourceHash,
    });

    if (input.name !== undefined) {
      // The slug is deliberately not updatable. It appears in URLs, in
      // invitations already sent, and in public creator-facing pages — changing
      // it silently breaks links other people hold.
      await this.prisma.organization.update({
        where: { id: organizationId },
        data: { name: input.name },
      });
    }

    await this.audit.record({
      action: AuditAction.OrganizationUpdated,
      organizationId,
      actorUserId,
      subjectType: 'organization',
      subjectId: organizationId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { changed: input.name !== undefined ? ['name'] : [] },
    });

    return this.get(organizationId);
  }

  async listInvitations(organizationId: string) {
    const invitations = await this.prisma.invitation.findMany({
      where: { organizationId },
      select: {
        id: true,
        email: true,
        role: true,
        invitedBy: true,
        createdAt: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const inviterIds = [...new Set(invitations.map((invitation) => invitation.invitedBy))];
    const inviters = await this.prisma.user.findMany({
      where: { id: { in: inviterIds } },
      select: { id: true, email: true },
    });
    const emailById = new Map(inviters.map((user) => [user.id, user.email]));

    const now = new Date();
    return invitations.map((invitation) => ({
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      // Derived, in this order: an accepted invitation stays accepted even
      // after its expiry passes, and a revoked one is revoked whatever the
      // clock says.
      status: invitation.acceptedAt
        ? ('accepted' as const)
        : invitation.revokedAt
          ? ('revoked' as const)
          : invitation.expiresAt < now
            ? ('expired' as const)
            : ('pending' as const),
      invitedByEmail: emailById.get(invitation.invitedBy) ?? 'unknown@rayi.com',
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
    }));
  }

  /**
   * Revoke an invitation.
   *
   * A state change, not a delete. The row stays because "who was invited, by
   * whom, and who cancelled it" is exactly the history an investigation needs —
   * and an append-only audit trail beside a table that quietly loses rows is
   * only half a record.
   */
  async revokeInvitation(
    organizationId: string,
    invitationId: string,
    actorUserId: string,
    context: RequestContext,
  ): Promise<boolean> {
    const revoked = await this.prisma.invitation.updateMany({
      where: {
        id: invitationId,
        organizationId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) {
      // Either it does not exist in this organization, or it was already
      // accepted or revoked. Both are 404 rather than 403, for the same reason
      // everywhere else: a 403 confirms it exists.
      throw new NotFoundException();
    }

    await this.audit.record({
      action: AuditAction.InvitationRevoked,
      organizationId,
      actorUserId,
      subjectType: 'invitation',
      subjectId: invitationId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    return true;
  }
}
