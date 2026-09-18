import { Job as AllJobs, Queue as QueueName } from '@/constants/job.constant';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailQueueService } from './email.service';
import { EmailJob } from './email.type';

const EmailJob = AllJobs.Email;

@Processor(QueueName.Email, {
  concurrency: 1,
  drainDelay: 300,
  stalledInterval: 300000,
  removeOnComplete: {
    age: 86400,
    count: 100,
  },
  limiter: {
    max: 1,
    duration: 150,
  },
})
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);
  constructor(private readonly emailQueueService: EmailQueueService) {
    super();
  }
  async process(job: EmailJob, _token?: string): Promise<any> {
    this.logger.debug(`Processing job ${job.id} of type ${job.name}.`);

    switch (job.name) {
      case EmailJob.EmailVerification:
        return await this.emailQueueService.verifyEmail(job.data);
      case EmailJob.SignInMagicLink:
        return await this.emailQueueService.sendMagicLink(job.data);
      case EmailJob.ResetPassword:
        return await this.emailQueueService.resetPassword(job.data);
      default:
        throw new Error(`Unhandled job named: ${(job as any).name}`);
    }
  }

  @OnWorkerEvent('active')
  async onActive(job: Job) {
    this.logger.debug(`Job ${job.id} is now active`);
  }

  @OnWorkerEvent('progress')
  async onProgress(job: Job) {
    this.logger.debug(`Job ${job.id} is ${job.progress}% complete`);
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job) {
    this.logger.debug(`Job ${job.id} has been completed`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job) {
    this.logger.error(
      `Job ${job.id} has failed with reason: ${job.failedReason}`,
    );
    this.logger.error(job.stacktrace);
  }

  @OnWorkerEvent('stalled')
  async onStalled(job: Job) {
    this.logger.error(`Job ${job.id} has been stalled`);
  }

  @OnWorkerEvent('error')
  async onError(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} has failed with error: ${error.message}`);
  }
}
