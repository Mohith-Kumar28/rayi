import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { PrismaService } from '@/database/prisma.service';
import { isCheckViolation } from '@/database/sqlstate';

import type { BudgetPort } from './public/budget.port';

/**
 * Workspaces and their budget envelopes.
 *
 * **A workspace holds no money.** It groups campaigns and people, and its
 * envelope is an authorization ceiling: campaigns still allocate from the
 * organization balance, and the envelope decides whether a given allocation is
 * permitted at all.
 *
 * Two rules carry the design:
 *
 * **Every query is scoped by `organizationId` in the WHERE clause**, and a miss
 * is a 404 rather than a 403 — a 403 confirms the workspace exists, which is an
 * enumeration oracle for anybody holding a stolen id.
 *
 * **Draw-down is a conditional UPDATE, never read-then-write.** The CHECK
 * constraint is the real guarantee; the conditional predicate is what turns a
 * violation into a clean refusal instead of a 23514 the caller has to decode.
 */

export interface EnvelopeView {
  readonly ceilingMinor: bigint;
  readonly committedMinor: bigint;
  readonly remainingMinor: bigint;
  readonly currency: string;
  readonly expiresAt: Date | null;
  readonly approvedByEmail: string | null;
  readonly approvedAt: Date | null;
}

/**
 * Workspace access roles.
 *
 * `finance_approver` is the one that matters and is the reason workspaces are
 * Rayi tables rather than Better Auth teams: Better Auth's `teamMember` has no
 * role column at all, and team-scoped permissions were requested and closed as
 * not planned — while "approves budgets for the UK market only" is precisely
 * what an organization-wide role string cannot say.
 */
export const WORKSPACE_ROLES = ['viewer', 'member', 'finance_approver'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

@Injectable()
export class WorkspacesService implements BudgetPort {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  private toEnvelopeView(
    envelope: {
      ceilingMinor: bigint;
      committedMinor: bigint;
      currency: string;
      expiresAt: Date | null;
      approvedAt: Date;
      approvedByMemberId: string | null;
    } | null,
    approverEmail: string | null,
  ): EnvelopeView | null {
    if (!envelope) return null;
    return {
      ceilingMinor: envelope.ceilingMinor,
      committedMinor: envelope.committedMinor,
      // Computed HERE, in one place, and never in a browser. It also floors at
      // zero: an envelope whose ceiling was lowered below what is committed is
      // over-committed, not in credit, and a negative "remaining" on a screen
      // reads as money available.
      remainingMinor:
        envelope.ceilingMinor > envelope.committedMinor
          ? envelope.ceilingMinor - envelope.committedMinor
          : 0n,
      currency: envelope.currency,
      expiresAt: envelope.expiresAt,
      approvedByEmail: approverEmail,
      approvedAt: envelope.approvedAt,
    };
  }

  async list(organizationId: string) {
    const workspaces = await this.prisma.workspace.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        envelope: true,
        _count: { select: { campaigns: true, members: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const approverIds = workspaces
      .map((workspace) => workspace.envelope?.approvedByMemberId)
      .filter((id): id is string => id != null);
    const approvers = await this.approverEmails(organizationId, approverIds);

    return workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      campaignCount: workspace._count.campaigns,
      memberCount: workspace._count.members,
      envelope: this.toEnvelopeView(
        workspace.envelope,
        workspace.envelope?.approvedByMemberId
          ? (approvers.get(workspace.envelope.approvedByMemberId) ?? null)
          : null,
      ),
    }));
  }

  /**
   * Emails for a set of member ids, scoped to the organization.
   *
   * Scoped even though the ids came from our own rows: a helper that will look
   * up any member by id is a helper somebody eventually calls with an id from
   * somewhere else.
   */
  private async approverEmails(
    organizationId: string,
    memberIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (memberIds.length === 0) return new Map();
    const members = await this.prisma.member.findMany({
      where: { organizationId, id: { in: [...memberIds] } },
      select: { id: true, user: { select: { email: true } } },
    });
    return new Map(members.map((member) => [member.id, member.user.email]));
  }

  async get(organizationId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      // Both predicates, always. Finding by id and then comparing the org is the
      // same shape as the tenant bugs this codebase exists to avoid.
      where: { id: workspaceId, organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        envelope: true,
        members: {
          select: {
            memberId: true,
            role: true,
            createdAt: true,
            member: { select: { role: true, user: { select: { email: true } } } },
          },
          orderBy: { createdAt: 'asc' },
        },
        campaigns: {
          select: { id: true, name: true, state: true, currency: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { campaigns: true, members: true } },
      },
    });

    if (!workspace) throw new NotFoundException();

    const approvers = await this.approverEmails(
      organizationId,
      workspace.envelope?.approvedByMemberId ? [workspace.envelope.approvedByMemberId] : [],
    );

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      campaignCount: workspace._count.campaigns,
      memberCount: workspace._count.members,
      envelope: this.toEnvelopeView(
        workspace.envelope,
        workspace.envelope?.approvedByMemberId
          ? (approvers.get(workspace.envelope.approvedByMemberId) ?? null)
          : null,
      ),
      members: workspace.members.map((row) => ({
        memberId: row.memberId,
        email: row.member.user.email,
        orgRole: row.member.role,
        isFinanceApprover: row.role === 'finance_approver',
        addedAt: row.createdAt,
      })),
      campaigns: workspace.campaigns.map((campaign) => ({
        campaignId: campaign.id,
        name: campaign.name,
        state: campaign.state,
        currency: campaign.currency,
      })),
    };
  }

  async create(
    organizationId: string,
    input: { name: string; slug: string },
    actorUserId: string,
    context: RequestContext,
  ) {
    const existing = await this.prisma.workspace.findFirst({
      where: { organizationId, slug: input.slug },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('A workspace with that address already exists.');
    }

    const workspace = await this.prisma.workspace.create({
      data: { organizationId, name: input.name, slug: input.slug },
      select: { id: true, name: true, slug: true, createdAt: true },
    });

    await this.audit.record({
      action: AuditAction.WorkspaceCreated,
      organizationId,
      actorUserId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { workspaceId: workspace.id, slug: workspace.slug },
    });

    return {
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      campaignCount: 0,
      memberCount: 0,
      envelope: null,
    };
  }

  async rename(
    organizationId: string,
    workspaceId: string,
    name: string,
    actorUserId: string,
    context: RequestContext,
  ) {
    // `updateMany` with both predicates, so the tenant check is part of the
    // write rather than a separate read somebody could skip.
    const updated = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, organizationId },
      data: { name },
    });
    if (updated.count === 0) throw new NotFoundException();

    await this.audit.record({
      action: AuditAction.WorkspaceUpdated,
      organizationId,
      actorUserId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { workspaceId, name },
    });

    const workspaces = await this.list(organizationId);
    const workspace = workspaces.find((row) => row.workspaceId === workspaceId);
    if (!workspace) throw new NotFoundException();
    return workspace;
  }

  /**
   * Approve or change a workspace's ceiling.
   *
   * **This moves no money.** It changes what future allocations are permitted to
   * do, which is why it is gated by step-up rather than by money authority: it
   * is an authorization decision, and treating it as a payment would put it
   * behind a control it does not need while leaving the control it does need
   * (proving who is at the keyboard) unstated.
   *
   * A ceiling below what is already committed is REFUSED rather than clamped.
   * Lowering it claws nothing back — deals already accepted keep their money —
   * so accepting the write would only make the stored numbers disagree with the
   * deals that are running.
   */
  async setEnvelope(
    organizationId: string,
    workspaceId: string,
    input: {
      ceilingMinor: bigint;
      currency: string;
      expiresAt: Date | null;
      code: string;
    },
    actorUserId: string,
    context: RequestContext,
  ) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId },
      select: { id: true, envelope: true },
    });
    if (!workspace) throw new NotFoundException();

    // Bound to this workspace, single-use, and consumed atomically. The hash is
    // computed here from what the server is about to do — never from anything a
    // client says it is confirming.
    // The hash is computed HERE, from what the server is about to do. A
    // client-supplied binding is not a binding: whoever sends it chooses what
    // the grant covers.
    const resourceHash = StepUpService.resourceHash({
      workspaceId,
      organizationId,
      ceilingMinor: input.ceilingMinor.toString(),
    });

    await this.stepUp.mint({
      userId: actorUserId,
      purpose: StepUpPurpose.ApproveBudget,
      code: input.code,
      resourceHash,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    await this.stepUp.consume({
      userId: actorUserId,
      purpose: StepUpPurpose.ApproveBudget,
      resourceHash,
    });

    const committedMinor = workspace.envelope?.committedMinor ?? 0n;
    if (input.ceilingMinor < committedMinor) {
      throw new ConflictException(
        'That ceiling is below what this workspace has already committed. Lowering a ceiling ' +
          'stops new deals being offered; it cannot take back money already promised to a creator.',
      );
    }

    const member = await this.prisma.member.findFirst({
      where: { organizationId, userId: actorUserId },
      select: { id: true, user: { select: { email: true } } },
    });

    const envelope = await this.prisma.budgetEnvelope.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        organizationId,
        ceilingMinor: input.ceilingMinor,
        currency: input.currency,
        expiresAt: input.expiresAt,
        approvedByMemberId: member?.id ?? null,
      },
      // `committedMinor` is deliberately absent. It is drawn down by allocation
      // and is never something an approval writes — an approval that could also
      // reset the committed figure would be an approval that can create headroom
      // out of nothing.
      update: {
        ceilingMinor: input.ceilingMinor,
        currency: input.currency,
        expiresAt: input.expiresAt,
        approvedByMemberId: member?.id ?? null,
        approvedAt: new Date(),
      },
    });

    await this.audit.record({
      action: AuditAction.BudgetEnvelopeApproved,
      organizationId,
      actorUserId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: {
        workspaceId,
        ceilingMinor: input.ceilingMinor.toString(),
        expiresAt: input.expiresAt?.toISOString() ?? null,
      },
    });

    return this.toEnvelopeView(envelope, member?.user.email ?? null)!;
  }

  /**
   * Draw down a workspace's ceiling.
   *
   * **A conditional UPDATE, never read-then-write.** Two concurrent allocations
   * that both read the same remaining figure would both pass an application-side
   * check; here the predicate and the increment are one statement, so the loser
   * updates zero rows. The CHECK constraint is still the real guarantee — this
   * turns a would-be 23514 into a clean `false` the caller can act on.
   *
   * Returns false when there is no envelope, when it has expired, or when the
   * draw-down would exceed the ceiling. All three refuse NEW commitments and
   * none of them touch anything already committed.
   */
  async tryCommit(
    organizationId: string,
    workspaceId: string,
    amountMinor: bigint,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (amountMinor <= 0n) return true;

    try {
      const committed = await this.prisma.budgetEnvelope.updateMany({
        where: {
          workspaceId,
          organizationId,
          // An expired envelope behaves exactly like an exhausted one.
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { committedMinor: { increment: amountMinor } },
      });

      // No envelope, or an expired one. Nothing is approved, which must never
      // read as unlimited.
      return committed.count > 0;
    } catch (error) {
      /*
       * The CHECK refused it, which is the guarantee working.
       *
       * Prisma cannot express `ceiling - committed >= amount` as a predicate, so
       * the over-commit is caught by the constraint rather than by the WHERE
       * clause — and that is the right way round: the database is the authority
       * and the race is impossible by construction, not by an application-side
       * check somebody can forget.
       *
       * Matched on the constraint NAME, not on the bare SQLSTATE. A blanket
       * check-violation catch would also swallow `budget_envelope_non_negative`,
       * and a bug that produced a negative commitment would be reported to the
       * caller as an ordinary "ceiling reached".
       */
      if (isCheckViolation(error, 'budget_envelope_within_ceiling')) return false;
      throw error;
    }
  }

  /** Release a commitment — a terminated deal returning its uncommitted remainder. */
  async release(organizationId: string, workspaceId: string, amountMinor: bigint): Promise<void> {
    if (amountMinor <= 0n) return;
    await this.prisma.budgetEnvelope.updateMany({
      where: { workspaceId, organizationId, committedMinor: { gte: amountMinor } },
      data: { committedMinor: { decrement: amountMinor } },
    });
  }

  async addMember(
    organizationId: string,
    workspaceId: string,
    input: { memberId: string; isFinanceApprover: boolean },
    actorUserId: string,
    context: RequestContext,
  ) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException();

    // Must already be a member of THIS organization. The composite FK enforces
    // it too; checking here is what turns a foreign-key error into a sentence.
    const member = await this.prisma.member.findFirst({
      where: { id: input.memberId, organizationId },
      select: { id: true, role: true, user: { select: { email: true } } },
    });
    if (!member) throw new NotFoundException();

    const role: WorkspaceRole = input.isFinanceApprover ? 'finance_approver' : 'member';

    const existing = await this.prisma.workspaceMember.findFirst({
      where: { workspaceId, memberId: input.memberId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('They already have access to this workspace.');

    const created = await this.prisma.workspaceMember.create({
      data: { workspaceId, memberId: input.memberId, organizationId, role },
      select: { createdAt: true },
    });

    await this.audit.record({
      action: AuditAction.WorkspaceMemberAdded,
      organizationId,
      actorUserId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { workspaceId, memberId: input.memberId, role },
    });

    return {
      memberId: input.memberId,
      email: member.user.email,
      orgRole: member.role,
      isFinanceApprover: role === 'finance_approver',
      addedAt: created.createdAt,
    };
  }

  async removeMember(
    organizationId: string,
    workspaceId: string,
    memberId: string,
    actorUserId: string,
    context: RequestContext,
  ): Promise<boolean> {
    const removed = await this.prisma.workspaceMember.deleteMany({
      where: { workspaceId, memberId, organizationId },
    });
    if (removed.count === 0) throw new NotFoundException();

    await this.audit.record({
      action: AuditAction.WorkspaceMemberRemoved,
      organizationId,
      actorUserId,
      requestId: context.requestId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      data: { workspaceId, memberId },
    });

    return true;
  }
}
