import { PrismaModule } from '@/database/prisma.module';
import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { FileModule } from './file/file.module';
import { FundingModule } from './funding/funding.module';
import { HealthModule } from './health/health.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    HealthModule,
    UserModule,
    FileModule,
    FundingModule,
    AccountModule,
    PrismaModule,
  ],
})
export class ApiModule {}
