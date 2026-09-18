import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { AuditService } from './audit.service';

/**
 * Global, because almost every module has something worth recording and
 * threading an import through each of them adds no safety — only friction that
 * makes "skip the audit row" the path of least resistance.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
