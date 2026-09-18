import { PrismaModule } from '@/database/prisma.module';
import { Module } from '@nestjs/common';
import { AccountModule } from './account/account.module';
import { FileModule } from './file/file.module';
import { FundingModule } from './funding/funding.module';
import { AdminModule } from './admin/admin.module';
import { CreatorModule } from './creator/creator.module';
import { DealsModule } from './deals/deals.module';
import { HealthModule } from './health/health.module';
import { MembersModule } from './members/members.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { OrganizationModule } from './organization/organization.module';
import { PayoutsModule } from './payouts/payouts.module';
import { RosterModule } from './roster/roster.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
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
    OrganizationModule,
    WorkspacesModule,
    CampaignsModule,
    DealsModule,
    RosterModule,
    PayoutsModule,
    CreatorModule,
    AdminModule,
    WebhooksModule,
    PrismaModule,
  ],
})
export class ApiModule {}
