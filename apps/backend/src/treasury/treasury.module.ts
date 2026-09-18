import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/authorization/authorization.module';
import { PrismaModule } from '@/database/prisma.module';

import { AllocateBudgetUseCase } from './use-cases/allocate-budget.use-case';

/**
 * Treasury, API side.
 *
 * Contains only the use cases that RECORD an intent. Note what it does not
 * import: `LedgerModule`. The api process has no ledger repository in its graph,
 * no `ledger.post_entry` call site, and a database role with no grants on the
 * `ledger` schema at all — three independent layers saying the same thing.
 *
 * The processors live in `TreasuryWorkerModule`, which is bound only in the
 * worker's graph. Keeping them in separate modules matters because a Nest module
 * is a DI boundary and not an import boundary: `providers` controls what is
 * instantiated, never what can be reached by an `import` statement. The import
 * graph is policed separately, by dependency-cruiser in CI.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule],
  providers: [AllocateBudgetUseCase],
  exports: [AllocateBudgetUseCase],
})
export class TreasuryModule {}
