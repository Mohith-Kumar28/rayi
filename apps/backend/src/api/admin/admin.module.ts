import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * The only module that reads across tenants.
 *
 * It imports no ledger module and holds no ledger call site: `rayi_api` has no
 * grants on that schema, so money figures come from the worker-computed
 * `platform_snapshot` instead. That is not a workaround — it is the privilege
 * boundary being respected rather than discovered in production.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
