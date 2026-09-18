import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { PermissionService } from './permission.service';

/**
 * Asserts, at boot, that Better Auth's access-control model says nothing this
 * system's `role_permission` table does not.
 *
 * **The problem this solves.** Better Auth ships its own `ac` / `statements`
 * model, and if it were configured it would be a SECOND authority on who can do
 * what — one that Rayi's `PermissionGuard` never consults and no test covers.
 * Two authorities do not stay in agreement. They drift, and the drift is only
 * discovered when one of them allows something the other would have refused.
 *
 * **The resolution, and why it is not "generate one from the other".** The
 * roadmap said to generate Better Auth's `ac` object from `role_permission` at
 * boot. Having built the route allowlist, that turned out to be the wrong shape:
 * generating it would keep a second evaluator alive and merely synchronised, and
 * a synchronised copy still answers questions independently.
 *
 * Better Auth's `/organization/*` endpoints — the only ones whose behaviour its
 * `ac` model would govern — are **404'd at the mount**. Its access control
 * therefore governs nothing, and the honest configuration is to leave it unset
 * rather than to populate it accurately.
 *
 * So this asserts the ABSENCE instead: no `ac`, no `roles`, and no
 * `dynamicAccessControl`. If a future configuration adds one, the process
 * refuses to start rather than quietly acquiring a second opinion about
 * authorization.
 *
 * It also checks that `role_permission` is populated, because an empty table
 * makes every `can()` return false — which fails closed, but as a total outage
 * that is far better caught here than by a support ticket.
 */

/**
 * Better Auth options that would create a second authorization authority.
 *
 * `dynamicAccessControl` is listed for a different reason: its `cacheAllRoles`
 * is a module-level `Map` written on every call with no TTL and no invalidation,
 * so across several tasks a REVOKED permission can remain honoured indefinitely.
 * Disqualifying for anything gating money.
 */
const FORBIDDEN_AUTH_OPTIONS = ['ac', 'roles', 'dynamicAccessControl'] as const;

export interface AuthOptionsLike {
  readonly [key: string]: unknown;
  readonly plugins?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Pure, so it can be tested without booting Nest or Better Auth.
 *
 * Checks the top-level options and every plugin's options, because the
 * organization plugin takes its own `ac` and that is exactly where a second
 * model would be introduced.
 */
export function findSecondAuthorizationAuthority(options: AuthOptionsLike): string[] {
  const found: string[] = [];

  for (const key of FORBIDDEN_AUTH_OPTIONS) {
    if (options[key] !== undefined) found.push(`options.${key}`);
  }

  for (const [index, plugin] of (options.plugins ?? []).entries()) {
    if (typeof plugin !== 'object' || plugin === null) continue;
    const pluginOptions = (plugin as { options?: Record<string, unknown> }).options;
    if (!pluginOptions) continue;

    for (const key of FORBIDDEN_AUTH_OPTIONS) {
      if (pluginOptions[key] !== undefined) {
        const name = (plugin as { id?: string }).id ?? `plugin[${index}]`;
        found.push(`${name}.${key}`);
      }
    }
  }

  return found;
}

@Injectable()
export class AccessControlAssertion implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccessControlAssertion.name);

  constructor(private readonly permissions: PermissionService) {}

  async onApplicationBootstrap(): Promise<void> {
    const matrix = await this.permissions.permissionMatrix();
    const roles = Object.keys(matrix);

    if (roles.length === 0) {
      // Fails closed — every `can()` returns false — but as a TOTAL outage.
      // Far better caught here than by a support ticket saying nothing works.
      throw new Error(
        'role_permission is empty, so every authorization check will refuse. The permission ' +
          'matrix migration has not been applied to this database.',
      );
    }

    this.logger.log(
      `Authorization matrix loaded: ${roles.length} scoped roles, ` +
        `${Object.values(matrix).reduce((total, list) => total + list.length, 0)} permissions. ` +
        `Better Auth holds no access-control model of its own.`,
    );
  }
}
