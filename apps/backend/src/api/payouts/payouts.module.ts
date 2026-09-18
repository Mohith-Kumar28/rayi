import { Module } from '@nestjs/common';

import { AuditModule } from '@/audit/audit.module';
import { AuthorizationModule } from '@/authorization/authorization.module';
import { StepUpModule } from '@/auth/step-up/step-up.module';
import { PrismaModule } from '@/database/prisma.module';

import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

/**
 * The creator's money.
 *
 * Reads only. Nothing here mints a provider link or moves a payout — minting an
 * AccountLink is a call against a connected account, and the api process holds
 * no full Stripe key. When that is wired it enqueues a treasury command and the
 * WORKER makes the call, exactly like every other Stripe interaction.
 */
@Module({
  imports: [PrismaModule, AuthorizationModule, StepUpModule, AuditModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
