import { Module } from '@nestjs/common';

import { AuditModule } from '@/audit/audit.module';
import { AuthorizationModule } from '@/authorization/authorization.module';
import { StepUpModule } from '@/auth/step-up/step-up.module';
import { PrismaModule } from '@/database/prisma.module';

import { WorkspacesModule } from '../workspaces/workspaces.module';

import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';
import { ReviewController } from './review.controller';
import { ReviewQueueService } from './review-queue.service';
import { ReviewService } from './review.service';

/**
 * Deals, deliverables and the review queue.
 *
 * `ReviewService` writes NO ledger entry. Approving transitions state and leaves
 * the release to a job that runs after the undo window — which honours the rule
 * that the api process never does money work inline, and gives every approval a
 * genuinely cancellable undo that never touches Stripe.
 *
 * So this module deliberately does not import `LedgerModule`, and
 * dependency-cruiser holds it to the same rule as every other api-side module.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, StepUpModule, AuditModule, WorkspacesModule],
  controllers: [ReviewController, DealsController],
  providers: [ReviewService, ReviewQueueService, DealsService],
  exports: [ReviewService, ReviewQueueService, DealsService],
})
export class DealsModule {}
