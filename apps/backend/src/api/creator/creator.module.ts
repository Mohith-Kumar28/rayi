import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { CreatorController } from './creator.controller';
import { CreatorService } from './creator.service';

/**
 * The creator surface.
 *
 * Separate from `DealsModule` on purpose: the brand reviews work and the creator
 * submits it, and those are different populations with different threat models.
 * Keeping them apart means a change to the review queue cannot widen what a
 * creator can see by accident.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CreatorController],
  providers: [CreatorService],
})
export class CreatorModule {}
