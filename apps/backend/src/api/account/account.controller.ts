import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  type AuditEventSchema,
  type DisableTwoFactorBodySchema,
  type RequestEmailChangeBodySchema,
  type SessionSummarySchema,
  type StartStepUpBodySchema,
  type UpdateProfileBodySchema,
  revokeMySession as revokeMySessionOperation,
} from '@rayi/contracts';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuditService } from '@/audit/audit.service';
import { StepUpPurpose, StepUpService } from '@/auth/step-up/step-up.service';
import type { RequestContext } from '@/common/types/request-context.type';
import { GlobalConfig } from '@/config/config.type';
import { Queue } from '@/constants/job.constant';
import {
  ValidatedBody,
  ValidatedParams,
} from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';
import type { EmailQueue } from '@/worker/queues/email/email.type';

import { AccountSecurityService } from './account-security.service';
import { AccountService } from './account.service';

/**
 * The account surface, replacing the Better Auth endpoints blocked at the mount.
 *
 * Every route here is `access: { kind: 'self' }`. The guard enforces only that
 * the caller is signed in, because "is this row yours" is a question about a row
 * the guard has not loaded. **So every query below scopes by the session's user
 * id in the WHERE clause**, and the integration tests assert that another user's
 * session id returns 404 rather than being revoked.
 *
 * The session user id comes from the session the AuthGuard resolved, never from
 * the request. There is deliberately no `userId` parameter anywhere in this
 * file — a route that accepted one would be one missing check away from letting
 * anyone act as anyone.
 */

type SessionSummaryDto = z.infer<typeof SessionSummarySchema>;
type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;
type AuditEventDto = z.infer<typeof AuditEventSchema>;
type RevokeParams = z.infer<
  NonNullable<typeof revokeMySessionOperation.pathParams>
>;
type StartStepUpBody = z.infer<typeof StartStepUpBodySchema>;
type RequestEmailChangeBody = z.infer<typeof RequestEmailChangeBodySchema>;
type DisableTwoFactorBody = z.infer<typeof DisableTwoFactorBodySchema>;

/**
 * `FastifyRequest.session` is declaration-merged in `src/types/fastify.d.ts` to
 * the Better Auth session the AuthGuard attaches. Using that type rather than a
 * local shape means a change to what the guard attaches breaks here at compile
 * time instead of becoming `undefined` at runtime.
 */
type SessionedRequest = FastifyRequest;

@ApiTags('account')
@Controller()
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly security: AccountSecurityService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<GlobalConfig>,
    @InjectQueue(Queue.Email) private readonly emailQueue: EmailQueue,
  ) {}

  @Operation('listMySessions')
  async listSessions(
    @Req() request: SessionedRequest,
  ): Promise<{ sessions: SessionSummaryDto[] }> {
    const { userId, token } = this.caller(request);
    const sessions = await this.account.listSessions(userId, token);

    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        current: session.current,
      })),
    };
  }

  @Operation('revokeMySession')
  async revokeSession(
    @ValidatedParams() params: RevokeParams,
    @Req() request: SessionedRequest,
  ): Promise<Record<string, never>> {
    const { userId } = this.caller(request);
    await this.account.revokeSession(
      userId,
      params.sessionId,
      this.context(request),
    );
    // 204 from the manifest's successStatus.
    return {};
  }

  @Operation('revokeMyOtherSessions')
  async revokeOtherSessions(
    @Req() request: SessionedRequest,
  ): Promise<{ revoked: number }> {
    const { userId, token } = this.caller(request);
    if (!token) {
      // Without knowing which session is the current one, "revoke the others"
      // cannot be answered safely — and guessing would sign the user out of the
      // device they are using to secure their account.
      throw new UnauthorizedException('Sign in to continue.');
    }
    return this.account.revokeOtherSessions(
      userId,
      token,
      this.context(request),
    );
  }

  @Operation('updateMyProfile')
  async updateProfile(
    @ValidatedBody() body: UpdateProfileBody,
    @Req() request: SessionedRequest,
  ): Promise<{ updated: boolean }> {
    const { userId } = this.caller(request);
    await this.account.updateProfile(userId, body, this.context(request));
    return { updated: true };
  }

  @Operation('listMyActivity')
  async listActivity(
    @Req() request: SessionedRequest,
  ): Promise<{ events: AuditEventDto[] }> {
    const { userId } = this.caller(request);
    const events = await this.audit.forUser(userId);

    return {
      events: events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        action: event.action,
        ipAddress: event.ipAddress,
      })),
    };
  }

  @Operation('startStepUp')
  async startStepUp(
    @ValidatedBody() body: StartStepUpBody,
    @Req() request: SessionedRequest,
  ): Promise<{ expiresAt: string }> {
    const { userId } = this.caller(request);

    // NO resource hash here, deliberately. This route mints an UNBOUND grant for
    // purposes that have no parameters. Anything with parameters — an amount, a
    // target member, a new address — mints its grant inside the handler that
    // knows those values, so the binding is computed from what the server is
    // about to do rather than from what a client claims it is confirming.
    const grant = await this.stepUp.mint({
      userId,
      purpose: body.purpose as StepUpPurpose,
      code: body.code,
      ...this.context(request),
    });

    return { expiresAt: grant.expiresAt.toISOString() };
  }

  @Operation('requestEmailChange')
  async requestEmailChange(
    @ValidatedBody() body: RequestEmailChangeBody,
    @Req() request: SessionedRequest,
  ): Promise<{ status: 'pending_confirmation' }> {
    const { userId } = this.caller(request);

    const change = await this.security.requestEmailChange({
      userId,
      newEmail: body.newEmail,
      code: body.code,
      context: this.context(request),
    });

    const appUrl = this.config.getOrThrow('app.url', { infer: true });

    // BOTH emails, and the order matters. The warning to the old address goes
    // first: if only one of the two can be delivered, the one that lets the real
    // owner stop an attack is worth more than the one that completes it.
    await this.emailQueue.add('email-change-notice', {
      email: change.oldEmail,
      newEmail: change.newEmail,
      cancelUrl: `${appUrl}/auth/email-change/cancel?token=${change.token}`,
    });
    await this.emailQueue.add('email-change-confirm', {
      email: change.newEmail,
      url: `${appUrl}/auth/email-change/confirm?token=${change.token}`,
    });

    // 202: the change has been RECORDED, not applied. Saying anything stronger
    // would be the UI asserting a fact that depends on an email arriving.
    return { status: 'pending_confirmation' };
  }

  @Operation('disableTwoFactor')
  async disableTwoFactor(
    @ValidatedBody() body: DisableTwoFactorBody,
    @Req() request: SessionedRequest,
  ): Promise<{ twoFactorEnabled: boolean }> {
    const { userId } = this.caller(request);
    await this.security.disableTwoFactor({
      userId,
      code: body.code,
      context: this.context(request),
    });
    return { twoFactorEnabled: false };
  }

  /**
   * The signed-in caller.
   *
   * The only source of identity in this controller. `PermissionGuard` has
   * already refused an anonymous request, so reaching here without a user id
   * would mean the guard chain changed underneath us — which is worth failing on
   * rather than assuming.
   */
  private caller(request: SessionedRequest): {
    userId: string;
    token: string | undefined;
  } {
    const userId = request.session?.user?.id;
    if (!userId) throw new UnauthorizedException('Sign in to continue.');
    return { userId, token: request.session?.session?.token };
  }

  /** Forensics for the audit row: enough to correlate with an access log. */
  private context(request: SessionedRequest): RequestContext {
    const forwarded = request.headers['x-forwarded-for'];
    return {
      requestId: request.id ? String(request.id) : undefined,
      // `request.ip` is already trustProxy-derived; the header is a fallback for
      // adapters that do not populate it. Both are attacker-influenced, which is
      // why this is recorded as evidence and never used for authorization.
      ipAddress:
        request.ip ??
        (typeof forwarded === 'string' ? forwarded.split(',')[0] : undefined),
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent'].slice(0, 500)
          : undefined,
    };
  }
}
