import { Controller, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  type AuditEventSchema,
  type SessionSummarySchema,
  type UpdateProfileBodySchema,
  revokeMySession as revokeMySessionOperation,
} from '@rayi/contracts';

import { AuditService } from '@/audit/audit.service';
import { ValidatedBody, ValidatedParams } from '@/decorators/operation-input.decorator';
import { Operation } from '@/decorators/operation.decorator';

import { AccountService, type RequestContext } from './account.service';

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
type RevokeParams = z.infer<NonNullable<typeof revokeMySessionOperation.pathParams>>;

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
    private readonly audit: AuditService,
  ) {}

  @Operation('listMySessions')
  async listSessions(@Req() request: SessionedRequest): Promise<{ sessions: SessionSummaryDto[] }> {
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
    await this.account.revokeSession(userId, params.sessionId, this.context(request));
    // 204 from the manifest's successStatus.
    return {};
  }

  @Operation('revokeMyOtherSessions')
  async revokeOtherSessions(@Req() request: SessionedRequest): Promise<{ revoked: number }> {
    const { userId, token } = this.caller(request);
    if (!token) {
      // Without knowing which session is the current one, "revoke the others"
      // cannot be answered safely — and guessing would sign the user out of the
      // device they are using to secure their account.
      throw new UnauthorizedException('Sign in to continue.');
    }
    return this.account.revokeOtherSessions(userId, token, this.context(request));
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
  async listActivity(@Req() request: SessionedRequest): Promise<{ events: AuditEventDto[] }> {
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

  /**
   * The signed-in caller.
   *
   * The only source of identity in this controller. `PermissionGuard` has
   * already refused an anonymous request, so reaching here without a user id
   * would mean the guard chain changed underneath us — which is worth failing on
   * rather than assuming.
   */
  private caller(request: SessionedRequest): { userId: string; token: string | undefined } {
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
      ipAddress: request.ip ?? (typeof forwarded === 'string' ? forwarded.split(',')[0] : undefined),
      userAgent: typeof request.headers['user-agent'] === 'string'
        ? request.headers['user-agent'].slice(0, 500)
        : undefined,
    };
  }
}
