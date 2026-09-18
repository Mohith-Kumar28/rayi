import { Job as AllJobs } from '@/constants/job.constant';
import { Job, JobsOptions, Queue } from 'bullmq';

const EmailJob = AllJobs.Email;

export interface EmailVerificationJob {
  name: typeof EmailJob.EmailVerification;
  data: {
    userId: string;
    url: string;
  };
}

export interface SignInMagicLinkJob {
  name: typeof EmailJob.SignInMagicLink;
  data: {
    email: string;
    url: string;
  };
}

export interface ResetPasswordJob {
  name: typeof EmailJob.ResetPassword;
  data: {
    userId: string;
    url: string;
  };
}

type JobDataMap = {
  [EmailJob.EmailVerification]: EmailVerificationJob['data'];
  [EmailJob.SignInMagicLink]: SignInMagicLinkJob['data'];
  [EmailJob.ResetPassword]: ResetPasswordJob['data'];
};

type QueueJob<N extends keyof JobDataMap> = {
  name: N;
  data: JobDataMap[N];
};

export type EmailQueue = Omit<Queue<QueueJob<keyof JobDataMap>>, 'add'> & {
  add<N extends keyof JobDataMap>(
    name: N,
    data: JobDataMap[N],
    options?: JobsOptions,
  ): Promise<void>;
};

export type EmailJob =
  | Job<EmailVerificationJob['data'], any, typeof EmailJob.EmailVerification>
  | Job<SignInMagicLinkJob['data'], any, typeof EmailJob.SignInMagicLink>
  | Job<ResetPasswordJob['data'], any, typeof EmailJob.ResetPassword>;
