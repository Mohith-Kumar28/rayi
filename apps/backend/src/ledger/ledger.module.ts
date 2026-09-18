import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { LedgerIntegrityService } from './infrastructure/ledger-integrity.service';
import { LedgerRepository } from './infrastructure/ledger.repository';

/**
 * The ledger.
 *
 * Bound in the WORKER's module graph only — never in the api's. The api process
 * has no import path here (enforced by dependency-cruiser) and its database role
 * has no grants on the `ledger` schema, so even a compromised api cannot post.
 *
 * `exports` is deliberately just the repository: nothing outside gets a Prisma
 * handle onto ledger tables. `LedgerIntegrityService` is NOT exported — it is not
 * something other code calls, it is something that runs at boot and refuses to
 * let this process serve if the database has lost a control the money-safety
 * argument depends on.
 */
@Module({
  imports: [PrismaModule],
  providers: [LedgerRepository, LedgerIntegrityService],
  exports: [LedgerRepository],
})
export class LedgerModule {}
