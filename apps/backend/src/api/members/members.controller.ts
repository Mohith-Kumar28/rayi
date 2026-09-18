import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  type ChangeMemberRoleBodySchema,
  type InviteMemberBodySchema,
  type MemberSchema,
  type RemoveMemberBodySchema,
  changeMemberRole as changeMemberRoleOperation,
  listMembers as listMembersOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { RequestContext } from '@/common/types/request-context.type';
import { GlobalConfig } from '@/config/config.type';
import { Queue } from '@/constants/job.constant';
import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';
import type { EmailQueue } from '@/worker/queues/email/email.type';

import { MembersService } from './members.service';

/**
 * Membership, on Rayi's own routes.
 *
 * Every one carries `@Operation(...)`, so `PermissionGuard` sees it, the
 * route-coverage test enumerates it, and the published OpenAPI document
 * describes it. None of those three were true of Better Auth's
 * `/organization/*` endpoints, which is why they are 404'd at the mount.
 */

type MemberDto = z.infer<typeof MemberSchema>;
type InviteBody = z.infer<typeof InviteMemberBodySchema>;
type ChangeRoleBody = z.infer<typeof ChangeMemberRoleBodySchema>;
type RemoveBody = z.infer<typeof RemoveMemberBodySchema>;
type OrgParams = z.infer<NonNullable<typeof listMembersOperation.pathParams>>;
type MemberParams = z.infer<
  NonNullable<typeof changeMemberRoleOperation.pathParams>
>;

@ApiTags('members')
@Controller()
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly config: ConfigService<GlobalConfig>,
    @InjectQueue(Queue.Email) private readonly emailQueue: EmailQueue,
  ) {}

  @Operation('listMembers')
  async list(
    @ValidatedParams() params: OrgParams,
  ): Promise<{ members: MemberDto[] }> {
    const members = await this.members.list(params.orgId);
    return {
      members: members.map((member) => ({
        memberId: member.memberId,
        userId: member.userId,
        email: member.email,
        role: member.role as MemberDto['role'],
        createdAt: member.createdAt.toISOString(),
        hasMoneyAuthority: member.hasMoneyAuthority,
      })),
    };
  }

  @Operation('inviteMember')
  async invite(
    @ValidatedParams() params: OrgParams,
    @ValidatedBody() body: InviteBody,
    @Req() request: FastifyRequest,
  ): Promise<{ invitationId: string; status: 'pending' }> {
    const actorUserId = this.caller(request);

    const invitation = await this.members.invite({
      organizationId: params.orgId,
      actorUserId,
      email: body.email,
      role: body.role,
      context: this.context(request),
    });

    const appUrl = this.config.getOrThrow('app.url', { infer: true });
    await this.emailQueue.add('email-verification', {
      // Reusing the verification template: the recipient's task is identical —
      // prove they hold this address and land in the app. A dedicated invitation
      // template belongs with the onboarding screens, not before them.
      userId: actorUserId,
      url: `${appUrl}/invitations/accept?token=${invitation.token}`,
    });

    return { invitationId: invitation.invitationId, status: 'pending' };
  }

  @Operation('changeMemberRole')
  async changeRole(
    @ValidatedParams() params: MemberParams,
    @ValidatedBody() body: ChangeRoleBody,
    @Req() request: FastifyRequest,
  ): Promise<{ memberId: string; role: ChangeRoleBody['role'] }> {
    const result = await this.members.changeRole({
      organizationId: params.orgId,
      memberId: params.memberId,
      actorUserId: this.caller(request),
      role: body.role,
      code: body.code,
      context: this.context(request),
    });
    return {
      memberId: result.memberId,
      role: result.role as ChangeRoleBody['role'],
    };
  }

  @Operation('removeMember')
  async remove(
    @ValidatedParams() params: MemberParams,
    @ValidatedBody() body: RemoveBody,
    @Req() request: FastifyRequest,
  ): Promise<{ removed: boolean }> {
    await this.members.remove({
      organizationId: params.orgId,
      memberId: params.memberId,
      actorUserId: this.caller(request),
      code: body.code,
      context: this.context(request),
    });
    return { removed: true };
  }

  private caller(request: FastifyRequest): string {
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException('Sign in to continue.');
    return userId;
  }

  private context(request: FastifyRequest): RequestContext {
    return {
      requestId: request.id ? String(request.id) : undefined,
      ipAddress: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 500)
          : undefined,
    };
  }
}
