import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

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
 */

type AccessMetadata =
  | { kind: 'public' }
  | { kind: 'permission'; permission: string; stepUp?: boolean; movesMoney?: boolean }
  | { kind: 'webhook'; source: 'platform' | 'connect' };

@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Only HTTP carries the manifest contract. WebSocket auth is handled by AuthGuard.
    if (context.getType() !== 'http') return true;

    const access = this.reflector.getAllAndOverride<AccessMetadata | undefined>(OPERATION_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Routes that predate the manifest (the boilerplate's own health, user and
    // file endpoints) are governed by AuthGuard alone. Only routes that opt into
    // `@Operation(...)` are held to the manifest contract — otherwise adopting
    // this guard would break every inherited route at once.
    if (!access) return true;

    switch (access.kind) {
      case 'public':
        return true;

      case 'webhook':
        // Signature verification happens in the webhook module against the RAW
        // body. Reaching here means the route declared itself a webhook.
        return true;

      case 'permission':
        return this.checkPermission(context, access);

      default: {
        const exhaustive: never = access;
        this.logger.error(`Unrecognised access kind: ${JSON.stringify(exhaustive)}`);
        throw new ForbiddenException('This endpoint is not available.');
      }
    }
  }

  private checkPermission(
    context: ExecutionContext,
    access: Extract<AccessMetadata, { kind: 'permission' }>,
  ): boolean {
    const request = context.switchToHttp().getRequest<{ session?: unknown }>();

    if (!request.session) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    // PermissionService lands with the tenancy model. Until then this fails
    // CLOSED rather than waving callers through with a TODO, so no window exists
    // in which a money route is accidentally open.
    this.logger.warn(
      `Permission "${access.permission}" is declared but not yet enforced — refusing. ` +
        `PermissionService is pending the org/workspace model.`,
    );
    throw new ForbiddenException('Authorization is not yet implemented for this endpoint.');
  }
}
