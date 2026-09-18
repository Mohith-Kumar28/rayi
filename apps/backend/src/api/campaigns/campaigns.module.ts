import { Module } from '@nestjs/common';

import { AuditModule } from '@/audit/audit.module';
import { AuthorizationModule } from '@/authorization/authorization.module';
import { PrismaModule } from '@/database/prisma.module';

import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

/** Campaigns as objects. Allocating a budget to one is a money path and lives in `FundingModule`. */
@Module({
  imports: [PrismaModule, AuthorizationModule, AuditModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
