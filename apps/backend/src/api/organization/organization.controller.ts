import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type InvitationSchema,
  type OrganizationSchema,
  type UpdateOrganizationBodySchema,
  getOrganization as getOrganizationOperation,
  revokeInvitation as revokeInvitationOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { money } from '@/common/money/money.dto';
import type { RequestContext } from '@/common/types/request-context.type';
import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { OrganizationService } from './organization.service';

type OrgParams = z.infer<NonNullable<typeof getOrganizationOperation.pathParams>>;
type InvitationParams = z.infer<NonNullable<typeof revokeInvitationOperation.pathParams>>;
type OrganizationDto = z.infer<typeof OrganizationSchema>;
type InvitationDto = z.infer<typeof InvitationSchema>;
type UpdateBody = z.infer<typeof UpdateOrganizationBodySchema>;

@ApiTags('organization')
@Controller()
export class OrganizationController {
  constructor(private readonly organization: OrganizationService) {}

  @Operation('getOrganization')
  async get(@ValidatedParams() params: OrgParams): Promise<OrganizationDto> {
    return this.toDto(await this.organization.get(params.orgId));
  }

  @Operation('updateOrganization')
  async update(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: UpdateBody,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationDto> {
    const organization = await this.organization.update(
      params.orgId,
      { name: body.name, code: body.code },
      this.caller(request),
      this.context(request),
    );
    return this.toDto(organization);
  }

  @Operation('listInvitations')
  async listInvitations(
    @ValidatedParams() params: OrgParams,
  ): Promise<{ invitations: InvitationDto[] }> {
    const invitations = await this.organization.listInvitations(params.orgId);
    return {
      invitations: invitations.map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        role: invitation.role as InvitationDto['role'],
        status: invitation.status,
        invitedByEmail: invitation.invitedByEmail,
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    };
  }

  @Operation('revokeInvitation')
  async revokeInvitation(
    @ValidatedParams() params: InvitationParams,
    @Req() request: FastifyRequest,
  ): Promise<{ revoked: boolean }> {
    const revoked = await this.organization.revokeInvitation(
      params.orgId,
      params.invitationId,
      this.caller(request),
      this.context(request),
    );
    return { revoked };
  }

  private toDto(
    organization: Awaited<ReturnType<OrganizationService['get']>>,
  ): OrganizationDto {
    return {
      organizationId: organization.organizationId,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt.toISOString(),
      frozen: organization.frozen,
      dailyReleaseCeiling: money(organization.dailyReleaseCeilingMinor, organization.currency),
      dailyReleased: money(organization.dailyReleasedMinor, organization.currency),
      bankAccountLast4: organization.bankAccountLast4,
      bankAccountStatus: organization.bankAccountStatus,
    };
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
