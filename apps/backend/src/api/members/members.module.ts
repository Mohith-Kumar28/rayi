import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AuthorizationModule } from '@/authorization/authorization.module';
import { Queue } from '@/constants/job.constant';
import { PrismaModule } from '@/database/prisma.module';

import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [
    PrismaModule,
    AuthorizationModule,
    BullModule.registerQueue({ name: Queue.Email }),
  ],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
