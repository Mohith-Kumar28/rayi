import { Module } from '@nestjs/common';

import { TreasuryModule } from '@/treasury/treasury.module';

import { FundingController } from './funding.controller';

/**
 * Imports `TreasuryModule` — the API half — and never `TreasuryWorkerModule`.
 * The distinction is the whole architecture: this module is mounted on a public
 * ALB, and nothing reachable from it can post to the ledger.
 */
@Module({
  imports: [TreasuryModule],
  controllers: [FundingController],
})
export class FundingModule {}
