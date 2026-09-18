import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from './prisma.service';

/**
 * Runs work with a tenant set on the connection, so row-level security applies.
 *
 * **What this buys, stated honestly.** Every tenant query already carries its
 * predicate in the WHERE clause, and the composite foreign keys make a cross-org
 * row unrepresentable. RLS is the third layer, for the case the other two cannot
 * cover: a query someone writes LATER that forgets the predicate.
 *
 * The threat is not a malicious developer. It is
 * `findMany({ where: { state: 'live' } })` in a reporting endpoint six months
 * from now — correct-looking, reviewed, and returning every organization's rows.
 *
 * **What it does not buy.** RLS is only a control if the connection carries the
 * tenant, and Postgres cannot know which organization a pooled connection is
 * acting for. So this depends on application code calling it, exactly as the
 * WHERE clause does. What changes is the FAILURE MODE: a forgotten
 * `withTenant()` returns ZERO rows rather than everyone's rows — a visibly
 * broken feature instead of a silent cross-tenant leak.
 *
 * That asymmetry is the whole value, and it is worth saying plainly rather than
 * claiming RLS makes leaks impossible.
 */
@Injectable()
export class TenantScope {
  private readonly logger = new Logger(TenantScope.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` with `organizationId` set for the duration.
   *
   * Inside an interactive transaction, so the `SET LOCAL` and the queries share
   * one connection and the setting is reverted at COMMIT or ROLLBACK. `SET LOCAL`
   * rather than `SET`: a plain `SET` outlives the transaction and, on a pooled
   * connection, leaks the tenant into whatever runs next — which would be worse
   * than no RLS at all, because the next request would silently read someone
   * else's data while every check passed.
   */
  async withTenant<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!organizationId) {
      // An empty string would set the tenant to "" and match nothing, which is
      // a silent zero-row result rather than an obvious mistake.
      throw new Error('withTenant requires an organization id.');
    }

    return this.prisma.$transaction(async (tx) => {
      // Parameterised via `set_config`, not string interpolation into `SET`.
      // `SET LOCAL rayi.organization_id = '<value>'` cannot take a bind
      // parameter, so the interpolated form would be a genuine injection point
      // on a value that arrives from a URL.
      await tx.$executeRaw`SELECT set_config('rayi.organization_id', ${organizationId}, true)`;
      return work(tx);
    });
  }

  /**
   * Runs `work` across every tenant.
   *
   * For the work that is legitimately cross-tenant: the nightly reconciliation,
   * the super-admin surface, and the worker sweeping every pending treasury
   * command.
   *
   * Deliberately a SEPARATE, explicitly-named call rather than granting the
   * application role `BYPASSRLS` — which would make the policies decorative.
   * This appears in the code that uses it, it is greppable, and it cannot be
   * acquired by forgetting something.
   */
  async crossTenant<T>(reason: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    // Logged every time. Cross-tenant reads are rare and each one should be
    // explainable; a log line nobody can account for is the first sign that one
    // has been added carelessly.
    this.logger.log(`Cross-tenant query: ${reason}`);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rayi.cross_tenant', 'on', true)`;
      return work(tx);
    });
  }
}
