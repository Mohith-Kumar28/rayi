import { Module } from '@nestjs/common';
import { EmailQueueModule } from './queues/email/email.module';

@Module({
  imports: [EmailQueueModule],
})
export class WorkerModule {}
