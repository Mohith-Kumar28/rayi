import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/authorization/authorization.module';
import { PrismaModule } from '@/database/prisma.module';

import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

/** The brand's creator roster. Read-only, and derived from deals rather than from a membership table. */
@Module({
  imports: [PrismaModule, AuthorizationModule],
  controllers: [RosterController],
  providers: [RosterService],
  exports: [RosterService],
})
export class RosterModule {}
