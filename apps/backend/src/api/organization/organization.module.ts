import { Module } from '@nestjs/common';

import { AuditModule } from '@/audit/audit.module';
import { AuthorizationModule } from '@/authorization/authorization.module';
import { StepUpModule } from '@/auth/step-up/step-up.module';
import { PrismaModule } from '@/database/prisma.module';

import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/** The organization and its unaccepted invitations. */
@Module({
  imports: [PrismaModule, AuthorizationModule, StepUpModule, AuditModule],
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
