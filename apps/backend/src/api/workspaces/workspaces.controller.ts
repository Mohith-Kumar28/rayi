import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AddWorkspaceMemberBodySchema,
  type BudgetEnvelopeSchema,
  type CreateWorkspaceBodySchema,
  type SetBudgetEnvelopeBodySchema,
  type UpdateWorkspaceBodySchema,
  type WorkspaceDetailSchema,
  type WorkspaceMemberSchema,
  type WorkspaceSummarySchema,
  getWorkspace as getWorkspaceOperation,
  listWorkspaces as listWorkspacesOperation,
  removeWorkspaceMember as removeWorkspaceMemberOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { money, type MoneyDto } from '@/common/money/money.dto';
import type { RequestContext } from '@/common/types/request-context.type';
import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import type { EnvelopeView } from './workspaces.service';
import { WorkspacesService } from './workspaces.service';

/**
 * Workspaces.
 *
 * Every route carries `@Operation(...)`, so the authorization guard sees it, the
 * route-coverage test enumerates it, and the published OpenAPI document
 * describes it. Tenant scope comes from `{orgId}` in the URL on every one of
 * them — never from the session, which is shared mutable state across tabs and
 * would book an agency operator's work against the wrong brand.
 */

type OrgParams = z.infer<NonNullable<typeof listWorkspacesOperation.pathParams>>;
type WorkspaceParams = z.infer<NonNullable<typeof getWorkspaceOperation.pathParams>>;
type MemberParams = z.infer<NonNullable<typeof removeWorkspaceMemberOperation.pathParams>>;
type SummaryDto = z.infer<typeof WorkspaceSummarySchema>;
type DetailDto = z.infer<typeof WorkspaceDetailSchema>;
type EnvelopeDto = z.infer<typeof BudgetEnvelopeSchema>;
type WorkspaceMemberDto = z.infer<typeof WorkspaceMemberSchema>;
type CreateBody = z.infer<typeof CreateWorkspaceBodySchema>;
type UpdateBody = z.infer<typeof UpdateWorkspaceBodySchema>;
type EnvelopeBody = z.infer<typeof SetBudgetEnvelopeBodySchema>;
type AddMemberBody = z.infer<typeof AddWorkspaceMemberBodySchema>;

function toEnvelopeDto(envelope: EnvelopeView | null): EnvelopeDto | null {
  if (!envelope) return null;
  return {
    ceiling: money(envelope.ceilingMinor, envelope.currency),
    committed: money(envelope.committedMinor, envelope.currency),
    // Server-computed. The browser never subtracts money.
    remaining: money(envelope.remainingMinor, envelope.currency),
    expiresAt: envelope.expiresAt?.toISOString() ?? null,
    approvedByEmail: envelope.approvedByEmail,
    approvedAt: envelope.approvedAt?.toISOString() ?? null,
  };
}

@ApiTags('workspaces')
@Controller()
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Operation('listWorkspaces')
  async list(@ValidatedParams() params: OrgParams): Promise<{ workspaces: SummaryDto[] }> {
    const workspaces = await this.workspaces.list(params.orgId);
    return {
      workspaces: workspaces.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        slug: workspace.slug,
        createdAt: workspace.createdAt.toISOString(),
        campaignCount: workspace.campaignCount,
        memberCount: workspace.memberCount,
        envelope: toEnvelopeDto(workspace.envelope),
      })),
    };
  }

  @Operation('createWorkspace')
  async create(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: CreateBody,
    @Req() request: FastifyRequest,
  ): Promise<SummaryDto> {
    const workspace = await this.workspaces.create(
      params.orgId,
      body,
      this.caller(request),
      this.context(request),
    );
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt.toISOString(),
      campaignCount: workspace.campaignCount,
      memberCount: workspace.memberCount,
      envelope: null,
    };
  }

  @Operation('getWorkspace')
  async get(@ValidatedParams() params: WorkspaceParams): Promise<DetailDto> {
    const workspace = await this.workspaces.get(params.orgId, params.workspaceId);
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt.toISOString(),
      campaignCount: workspace.campaignCount,
      memberCount: workspace.memberCount,
      envelope: toEnvelopeDto(workspace.envelope),
      members: workspace.members.map((member) => ({
        memberId: member.memberId,
        email: member.email,
        orgRole: member.orgRole as WorkspaceMemberDto['orgRole'],
        isFinanceApprover: member.isFinanceApprover,
        addedAt: member.addedAt.toISOString(),
      })),
      campaigns: workspace.campaigns.map((campaign) => ({
        campaignId: campaign.campaignId,
        name: campaign.name,
        state: campaign.state as DetailDto['campaigns'][number]['state'],
        // Allocated is a LEDGER figure and the api process has no grants on the
        // ledger schema, so it is deliberately zero here rather than a number
        // this process cannot legitimately know. The campaign screen reads it
        // from the funding surface, which is fed by the worker.
        allocated: money(0n, campaign.currency),
      })),
    };
  }

  @Operation('updateWorkspace')
  async update(
    @ValidatedParams() params: WorkspaceParams,
    @ValidatedBody() body: UpdateBody,
    @Req() request: FastifyRequest,
  ): Promise<SummaryDto> {
    const workspace = await this.workspaces.rename(
      params.orgId,
      params.workspaceId,
      body.name ?? '',
      this.caller(request),
      this.context(request),
    );
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt.toISOString(),
      campaignCount: workspace.campaignCount,
      memberCount: workspace.memberCount,
      envelope: toEnvelopeDto(workspace.envelope),
    };
  }

  @Operation('setBudgetEnvelope')
  async setEnvelope(
    @ValidatedParams() params: WorkspaceParams,
    @ValidatedBody() body: EnvelopeBody,
    @Req() request: FastifyRequest,
  ): Promise<EnvelopeDto> {
    const envelope = await this.workspaces.setEnvelope(
      params.orgId,
      params.workspaceId,
      {
        // The client sends a string of minor units and the server parses it
        // once, here. No float is ever produced from it.
        ceilingMinor: BigInt(body.ceiling.amountMinor),
        currency: body.ceiling.currency,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        code: body.code,
      },
      this.caller(request),
      this.context(request),
    );
    return toEnvelopeDto(envelope)!;
  }

  @Operation('addWorkspaceMember')
  async addMember(
    @ValidatedParams() params: WorkspaceParams,
    @ValidatedBody() body: AddMemberBody,
    @Req() request: FastifyRequest,
  ): Promise<WorkspaceMemberDto> {
    const member = await this.workspaces.addMember(
      params.orgId,
      params.workspaceId,
      body,
      this.caller(request),
      this.context(request),
    );
    return {
      memberId: member.memberId,
      email: member.email,
      orgRole: member.orgRole as WorkspaceMemberDto['orgRole'],
      isFinanceApprover: member.isFinanceApprover,
      addedAt: member.addedAt.toISOString(),
    };
  }

  @Operation('removeWorkspaceMember')
  async removeMember(
    @ValidatedParams() params: MemberParams,
    @Req() request: FastifyRequest,
  ): Promise<{ removed: boolean }> {
    const removed = await this.workspaces.removeMember(
      params.orgId,
      params.workspaceId,
      params.memberId,
      this.caller(request),
      this.context(request),
    );
    return { removed };
  }

  private caller(request: FastifyRequest): string {
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException('Sign in to continue.');
    return userId;
  }

  private context(request: FastifyRequest): RequestContext {
    return {
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}

export type { MoneyDto };
