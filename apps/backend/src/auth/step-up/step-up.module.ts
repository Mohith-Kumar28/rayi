import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { StepUpService } from './step-up.service';

/**
 * Global, because step-up is a cross-cutting precondition rather than a feature
 * of one module — account changes, membership changes and money movement all
 * need it, and threading an import through each of them makes "skip the step-up"
 * the path of least resistance.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}
