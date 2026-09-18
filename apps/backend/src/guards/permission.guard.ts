import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { PermissionService } from '@/authorization/permission.service';
import { OPERATION_ACCESS } from '@/decorators/operation.decorator';

/**
 * Deny-by-default AUTHORIZATION.
 *
 * Separation of concerns from the existing `AuthGuard`, which answers a
 * different question:
 *
 *   AuthGuard        — "are you signed in?"   (authentication)
 *   PermissionGuard  — "may you do this?"     (authorization)
 *
 * Registered as a second `APP_GUARD` after `AuthGuard`, so the session is
 * already resolved onto the request by the time this runs.
 *
 * The rule it enforces: a handler carrying NO access declaration is refused.
 * Forgetting to declare access fails closed rather than shipping an open
 * endpoint. The boilerplate's `@Public()` model is opt-out for authentication;
 * this is opt-in for authorization, which is the stronger default when the
 * endpoint can move money.
 *
 * Unknown metadata is a denial, not a pass. If a future access kind is added and
 * this switch is not updated, routes using it stop working loudly instead of
 * becoming public quietly.
 *
 * **What this guard is not.** It enforces a CEILING — could this caller hold
 * this permission anywhere in the organization named in the URL — because the
 * URL is all it can see. The resource-scoped check belongs to the handler, which
 * knows which workspace the campaign lives in. Neither check is redundant and
 * neither is sufficient alone.
 */

type AccessMetadata =
  | { kind: 'public' }
  | { kind: 'self'; stepUp?: boolean }
  | {
      kind: 'permission';
      permission: string;
      stepUp?: boolean;
      movesMoney?: boolean;
    }
  | { kind: 'webhook'; source: 'platform' | 'connect' };

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionService) private readonly permissions: PermissionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only HTTP carries the manifest contract. WebSocket auth is handled by AuthGuard.
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessMetadata | undefined>(
      OPERATION_ACCESS,
      [context.getHandler(), context.getClass()],
    );

    // Routes that predate the manifest (the boilerplate's own health, user and
    // file endpoints) are governed by AuthGuard alone. Only routes that opt into
    // `@Operation(...)` are held to the manifest contract — otherwise adopting
    // this guard would break every inherited route at once.
    if (!access) return true;

    switch (access.kind) {
      case 'public':
        return true;

      case 'self':
        // Authenticated, acting on yourself. The guard's only job is to refuse
        // an anonymous caller; it cannot say more, because "is this row yours"
        // is a question about a row this guard has not loaded.
        //
        // The handler is therefore REQUIRED to scope every query by the
        // session's user id in the WHERE clause. That is not a convention this
        // guard can enforce, which is why it is written on the access kind
        // itself in @rayi/contracts and why each account endpoint has a test
        // asserting another user's resource returns 404.
        return this.requireSession(context);

      case 'webhook':
        // Signature verification happens in the webhook module against the RAW
        // body. Reaching here means the route declared itself a webhook.
        return true;

      case 'permission':
        return this.checkPermission(context, access);

      default: {
        const exhaustive: never = access;
        this.logger.error(
          `Unrecognised access kind: ${JSON.stringify(exhaustive)}`,
        );
        throw new ForbiddenException('This endpoint is not available.');
      }
    }
  }

  /** Authentication only. Used by `self` routes, which have no tenant to check. */
  private requireSession(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { session?: { user?: { id?: string } } }>();

    if (!request.session?.user?.id) {
      throw new UnauthorizedException('Sign in to continue.');
    }
    return true;
  }

  private async checkPermission(
    context: ExecutionContext,
    access: Extract<AccessMetadata, { kind: 'permission' }>,
  ): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        session?: { user?: { id?: string } };
        params?: Record<string, string>;
      }
    >();

    const userId = request.session?.user?.id;
    if (!userId) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    // SCOPE COMES FROM THE URL. Never from `session.activeOrganizationId`: that
    // field is shared mutable state across browser tabs, and an agency operator
    // with two clients open would otherwise have requests authorised against
    // whichever org they last switched to — with the access log recording a
    // scope that cannot be reconstructed.
    const orgId = request.params?.['orgId'];
    if (!orgId) {
      // The manifest test asserts every permission-gated operation carries
      // `{orgId}`, so reaching here means route and manifest have diverged.
      // Refusing is the only safe reading of "I do not know whose data this is".
      this.logger.error(
        `Route for permission "${access.permission}" has no orgId path parameter. Refusing.`,
      );
      throw new ForbiddenException('This endpoint is not available.');
    }

    const couldEver = await this.permissions.couldEver(
      userId,
      access.permission,
      orgId,
    );
    if (!couldEver) {
      // 404, not 403. A 403 for an organization the caller does not belong to
      // confirms that the organization exists, which turns every tenant route
      // into an enumeration oracle.
      this.logger.warn(
        `Denied ${access.permission} for ${userId} in org ${orgId}.`,
      );
      throw new NotFoundException('Not found.');
    }

    if (access.movesMoney === true) {
      // A money route additionally requires a MoneyAuthority row. The AMOUNT is
      // checked by the handler — the guard cannot see it, and pretending
      // otherwise is how a per-row limit ends up not applying to a batch.
      const holdsAuthority = await this.permissions.holdsAnyMoneyAuthority(
        userId,
        access.permission,
        orgId,
      );
      if (!holdsAuthority) {
        this.logger.warn(
          `Money authority absent: ${userId} attempted ${access.permission} in org ${orgId}.`,
        );
        throw new ForbiddenException('You are not authorised to move funds.');
      }
    }

    return true;
  }
}
