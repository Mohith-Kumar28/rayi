import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/authorization/authorization.module';
import { PrismaModule } from '@/database/prisma.module';
import { LedgerModule } from '@/ledger/ledger.module';

import { AllocateBudgetProcessor } from './processors/allocate-budget.processor';
import { TreasuryCommandListener } from './treasury-command.listener';

/**
 * Treasury, worker side. **Never imported by `AppModule.main()`.**
 *
 * This is the only module in the system that binds a ledger-posting provider,
 * and it is reachable only from the worker process — the one with no target
 * group, no listener and no inbound security-group rule. There is no route to
 * it because there is no server to route.
 *
 * It declares NO controller, so requirement "the payment service is never
 * publicly exposed" is satisfied structurally rather than by configuration:
 * there is no path to expose, so no deployment mistake can expose one.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, LedgerModule],
  providers: [AllocateBudgetProcessor, TreasuryCommandListener],
  exports: [AllocateBudgetProcessor],
})
export class TreasuryWorkerModule {}
