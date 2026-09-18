import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { AccountController } from './account.controller';
import { AccountService } from './account.service';

/**
 * `AuditService` is not imported: `AuditModule` is global, because almost every
 * module has something worth recording and threading the import through each of
 * them adds no safety — only friction that makes "skip the audit row" the path
 * of least resistance.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
