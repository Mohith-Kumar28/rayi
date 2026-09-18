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

/**
 * Notifying the OLD address that a change was requested.
 *
 * Sent to the address being moved AWAY from, because whoever holds it today is
 * the person who needs to hear about this while there is still time to object.
 */
export interface EmailChangeNoticeJob {
  name: typeof EmailJob.EmailChangeNotice;
  data: {
    /** The address being notified — the OLD one. */
    email: string;
    newEmail: string;
    /** Where the real owner goes to stop it. */
    cancelUrl: string;
  };
}

/** The confirmation link, sent to the NEW address. */
export interface EmailChangeConfirmJob {
  name: typeof EmailJob.EmailChangeConfirm;
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
  [EmailJob.EmailChangeNotice]: EmailChangeNoticeJob['data'];
  [EmailJob.EmailChangeConfirm]: EmailChangeConfirmJob['data'];
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
  | Job<ResetPasswordJob['data'], any, typeof EmailJob.ResetPassword>
  | Job<EmailChangeNoticeJob['data'], any, typeof EmailJob.EmailChangeNotice>
  | Job<EmailChangeConfirmJob['data'], any, typeof EmailJob.EmailChangeConfirm>;
