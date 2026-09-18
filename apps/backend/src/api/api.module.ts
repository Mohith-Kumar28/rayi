import { PrismaModule } from '@/database/prisma.module';
import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { FileModule } from './file/file.module';
import { FundingModule } from './funding/funding.module';
import { DealsModule } from './deals/deals.module';
import { HealthModule } from './health/health.module';
import { MembersModule } from './members/members.module';
import { UserModule } from './user/user.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    HealthModule,
    UserModule,
    FileModule,
    FundingModule,
    AccountModule,
    MembersModule,
    DealsModule,
    WebhooksModule,
    PrismaModule,
  ],
})
export class ApiModule {}
