import { Module } from '@nestjs/common';

import { AuditModule } from '@/audit/audit.module';
import { AuthorizationModule } from '@/authorization/authorization.module';
import { StepUpModule } from '@/auth/step-up/step-up.module';
import { PrismaModule } from '@/database/prisma.module';

import { BUDGET_PORT } from './public/budget.port';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * Workspaces and their budget envelopes.
 *
 * No ledger import, and none is needed: an envelope is an authorization ceiling,
 * not an account. The draw-down is a conditional UPDATE on an app-schema table
 * guarded by a CHECK — which is why this module stays on the api side of the
 * boundary that dependency-cruiser enforces.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, StepUpModule, AuditModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    // The narrow capability other feature modules may inject. Binding the
    // token to the same instance keeps one implementation without exposing it.
    { provide: BUDGET_PORT, useExisting: WorkspacesService },
  ],
  exports: [WorkspacesService, BUDGET_PORT],
})
export class WorkspacesModule {}
