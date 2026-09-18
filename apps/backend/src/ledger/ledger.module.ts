import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { LedgerRepository } from './infrastructure/ledger.repository';

/**
 * The ledger.
 *
 * Bound in the WORKER's module graph only — never in the api's. The api process
 * has no import path here (enforced by dependency-cruiser) and its database role
 * has no grants on the `ledger` schema, so even a compromised api cannot post.
 *
 * `exports` is deliberately just the repository: nothing outside gets a Prisma
 * handle onto ledger tables.
 */
@Module({
  imports: [PrismaModule],
  providers: [LedgerRepository],
  exports: [LedgerRepository],
})
export class LedgerModule {}
