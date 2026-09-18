import { Queue } from '@/constants/job.constant';
import { PrismaModule } from '@/database/prisma.module';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EmailQueueEvents } from './email.events';
import { EmailProcessor } from './email.processor';
import { EmailQueueService } from './email.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: Queue.Email,
      streams: {
        events: {
          maxLen: 1000,
        },
      },
    }),
  ],
  providers: [EmailQueueService, EmailProcessor, EmailQueueEvents],
})
export class EmailQueueModule {}
