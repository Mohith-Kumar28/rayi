import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';
import { LedgerModule } from '@/ledger/ledger.module';

import { PlatformSnapshotJob } from './platform-snapshot.job';

/**
 * Worker-side only. It reads the LEDGER, which the api process cannot — its
 * database role has no grants on that schema, so this could never have lived on
 * the admin endpoint however convenient that would have been.
 */
@Module({
  imports: [PrismaModule, LedgerModule],
  providers: [PlatformSnapshotJob],
})
export class PlatformSnapshotModule {}
