import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '@/database/prisma.service';

/**
 * The single authority on "who can do what".
 *
 * Two questions, deliberately answered by two different mechanisms:
 *
 *   `can()`            — does this member's ROLE permit this action?
 *   `hasMoneyAuthority()` — may this member MOVE MONEY, and up to what amount?
 *
 * A role never grants money capability. Better Auth stores roles comma-separated
 * and enforces no ceiling on invitations, so `MONEY_ROLES.has(role)` is false for
 * `'member,finance'` and an org admin can invite a mailbox they control as owner.
 * Making money capability a separate ROW, mintable only through a Rayi controller
 * under step-up and dual control, deletes that escalation class rather than
 * patching four hooks.
 *
 * Scope always comes from the caller's route parameters, never from
 * `session.activeOrganizationId` — that field is shared mutable state across
 * browser tabs, so an agency operator with two clients open would otherwise act
 * against the wrong brand.
 */

export interface PermissionScope {
  readonly organizationId: string;
  /** Present for workspace-scoped checks. */
  readonly workspaceId?: string;
}

export interface MoneyAuthorityCheck {
  readonly granted: boolean;
  /** Per-transaction ceiling in minor units. `null` means the org default applies. */
  readonly limitMinor: bigint | null;
  readonly reason?: string;
}

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves a user's effective permissions for a scope.
   *
   * Effective permissions are the UNION of their org-level role and, when a
   * workspace is named, their workspace-level role — because Better Auth roles
   * are org-wide and cannot express "finance approver in workspace A only".
   *
   * Returns an empty set when the user is not a member of the named organization,
   * so a caller from another tenant is indistinguishable from one with no
   * permissions. There is no separate "not a member" branch to forget.
   */
  async effectivePermissions(
    userId: string,
    scope: PermissionScope,
  ): Promise<Set<string>> {
    const member = await this.prisma.member.findFirst({
      where: { userId, organizationId: scope.organizationId },
      select: { id: true, role: true },
    });

    if (!member) return new Set();

    // Better Auth stores roles comma-separated, so a single value cannot be
    // assumed. Splitting is the only safe read.
    const orgRoles = member.role
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);

    const workspaceRoles: string[] = [];
    if (scope.workspaceId) {
      const workspaceMember = await this.prisma.workspaceMember.findFirst({
        where: {
          memberId: member.id,
          workspaceId: scope.workspaceId,
          // Belt and braces: the composite FK already makes a cross-org pairing
          // unrepresentable, but naming it here means a future schema change
          // cannot silently widen this query.
          organizationId: scope.organizationId,
        },
        select: { role: true },
      });
      if (workspaceMember) workspaceRoles.push(workspaceMember.role);
    }

    if (orgRoles.length === 0 && workspaceRoles.length === 0) return new Set();

    const rows = await this.prisma.rolePermission.findMany({
      where: {
        OR: [
          { scope: 'org', role: { in: orgRoles } },
          ...(workspaceRoles.length > 0
            ? [{ scope: 'workspace', role: { in: workspaceRoles } }]
            : []),
        ],
      },
      select: { permission: true },
    });

    return new Set(rows.map((row) => row.permission));
  }

  async can(
    userId: string,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    const permissions = await this.effectivePermissions(userId, scope);
    return permissions.has(permission);
  }

  /**
   * Whether this member may move money, and up to what amount.
   *
   * Separate from `can()` on purpose. A permission answers "is this action in
   * your job description"; money authority answers "are you trusted with funds".
   * A campaign manager has `campaign:allocate` in their role AND needs a
   * MoneyAuthority row before a single cent moves.
   */
  async hasMoneyAuthority(
    userId: string,
    capability: string,
    scope: PermissionScope,
    amountMinor?: bigint,
  ): Promise<MoneyAuthorityCheck> {
    const member = await this.prisma.member.findFirst({
      where: { userId, organizationId: scope.organizationId },
      select: { id: true },
    });

    if (!member) {
      return { granted: false, limitMinor: null, reason: 'not_a_member' };
    }

    const authority = await this.prisma.moneyAuthority.findFirst({
      where: {
        memberId: member.id,
        capability,
        organizationId: scope.organizationId,
        revokedAt: null,
      },
      select: { limitMinor: true },
    });

    if (!authority) {
      return { granted: false, limitMinor: null, reason: 'no_money_authority' };
    }

    if (
      amountMinor !== undefined &&
      authority.limitMinor !== null &&
      amountMinor > authority.limitMinor
    ) {
      this.logger.warn(
        `Money authority denied: ${capability} for ${amountMinor} exceeds limit ${authority.limitMinor}.`,
      );
      return {
        granted: false,
        limitMinor: authority.limitMinor,
        reason: 'exceeds_limit',
      };
    }

    return { granted: true, limitMinor: authority.limitMinor };
  }

  /**
   * The CEILING: could this user hold this permission anywhere in this
   * organization — under their org role, or under any workspace role they hold
   * within it?
   *
   * This is what the route guard can answer, and all it can answer. The guard
   * sees only the URL, and a workspace-scoped permission is not derivable from a
   * URL that names a campaign rather than a workspace.
   *
   * So authorization runs in two stages, and the split is deliberate rather than
   * a compromise:
   *
   *   guard      "could you ever"  — cheap, deny-by-default, before the handler
   *   use case   "may you here"    — scoped to the resource the request names,
   *                                  with that scope read from the database
   *
   * The ceiling is sound because it is a superset: a permission absent from
   * every role the user holds in the organization cannot be granted by narrowing
   * to one workspace. A route therefore fails closed at the guard, and the
   * handler still performs the real check — this never becomes the only one.
   */
  async couldEver(
    userId: string,
    permission: string,
    organizationId: string,
  ): Promise<boolean> {
    const member = await this.prisma.member.findFirst({
      where: { userId, organizationId },
      select: { id: true, role: true },
    });

    if (!member) return false;

    const orgRoles = member.role
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);

    const workspaceMemberships = await this.prisma.workspaceMember.findMany({
      where: { memberId: member.id, organizationId },
      select: { role: true },
    });

    const workspaceRoles = workspaceMemberships.map(
      (membership) => membership.role,
    );

    const match = await this.prisma.rolePermission.findFirst({
      where: {
        permission,
        OR: [
          { scope: 'org', role: { in: orgRoles } },
          ...(workspaceRoles.length > 0
            ? [{ scope: 'workspace', role: { in: workspaceRoles } }]
            : []),
        ],
      },
      select: { id: true },
    });

    return match !== null;
  }

  /**
   * Whether the user holds ANY unrevoked money authority for this capability in
   * this organization, ignoring the amount.
   *
   * The guard's counterpart to `couldEver`: it can refuse a money route before
   * the handler runs without knowing the amount, and the handler still enforces
   * the per-transaction limit. Checking only this would be a hole — it says
   * nothing about how much — so it is never the last check.
   */
  async holdsAnyMoneyAuthority(
    userId: string,
    capability: string,
    organizationId: string,
  ): Promise<boolean> {
    const member = await this.prisma.member.findFirst({
      where: { userId, organizationId },
      select: { id: true },
    });

    if (!member) return false;

    const authority = await this.prisma.moneyAuthority.findFirst({
      where: {
        memberId: member.id,
        capability,
        organizationId,
        revokedAt: null,
      },
      select: { id: true },
    });

    return authority !== null;
  }

  /**
   * Whether this user is platform staff.
   *
   * Resolved from the user's OWN `role` column against `role_permission` rows at
   * `scope: 'platform'` — never from an organization membership. A platform
   * permission reachable through an org role would make a sufficiently senior
   * brand owner into a super-admin, and the entire value of the separation is
   * that one compromised brand session cannot see every other brand.
   */
  async hasPlatformPermission(userId: string, permission: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { role: true },
    });

    if (!user) return false;

    // Comma-separated, like everywhere else Better Auth stores a role.
    const roles = user.role
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);

    if (roles.length === 0) return false;

    const match = await this.prisma.rolePermission.findFirst({
      where: { scope: 'platform', role: { in: roles }, permission },
      select: { id: true },
    });

    return match !== null;
  }

  /**
   * The full matrix, for generating Better Auth's `ac` object at boot.
   *
   * Generated FROM this table with a startup equality assertion, so there is one
   * authority on who can move money rather than two that drift apart.
   */
  async permissionMatrix(): Promise<Record<string, string[]>> {
    const rows = await this.prisma.rolePermission.findMany({
      select: { role: true, scope: true, permission: true },
      orderBy: [{ scope: 'asc' }, { role: 'asc' }, { permission: 'asc' }],
    });

    const matrix: Record<string, string[]> = {};
    for (const row of rows) {
      const key = `${row.scope}:${row.role}`;
      (matrix[key] ??= []).push(row.permission);
    }
    return matrix;
  }
}
