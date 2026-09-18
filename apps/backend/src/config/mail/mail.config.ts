import { registerAs } from '@nestjs/config';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Validate } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';
import { ValidatorConstraint } from 'class-validator';
import process from 'node:process';

import { isWorkerProcess } from '@/utils/config/is-worker-process';
import validateConfig from '@/utils/config/validate-config';

import type { MailConfig } from './mail-config.type';

/**
 * Transactional email, through Resend.
 *
 * SMTP is gone, and with it `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`,
 * `MAIL_REQUIRE_TLS`, `MAIL_IGNORE_TLS` and a nodemailer transport. An HTTPS API
 * with an API key has no TLS negotiation to get subtly wrong, no long-lived
 * connection to leak, and no `ignoreTLS` flag that silently downgrades a
 * production sender to plaintext because it was convenient once in development.
 *
 * **The key is worker-only, exactly like the Stripe secret key.**
 *
 * The api process is internet-reachable. A compromise there that could send mail
 * from our verified domain is a phishing capability against our own users, aimed
 * at exactly the population whose accounts receive money — and a magic link is a
 * credential, so "send email as Rayi" is very close to "sign in as anyone".
 *
 * The api never sends: it enqueues a BullMQ job and the worker sends. So the api
 * has no reason to hold the key, and a boot failure is what makes that true
 * rather than a comment.
 */

@ValidatorConstraint({ name: 'resendKeyOnlyOnWorker', async: false })
class ResendKeyOnlyOnWorker implements ValidatorConstraintInterface {
  validate(value: unknown, _args: ValidationArguments): boolean {
    if (typeof value !== 'string' || value === '') return true;
    // From the RAW environment. See is-worker-process.ts for why `args.object`
    // cannot be trusted for a boolean here.
    return isWorkerProcess();
  }

  defaultMessage(): string {
    return (
      'RESEND_API_KEY may only be present on the worker process. The api and webhooks ' +
      'processes are internet-reachable, and a compromise there that could send mail from our ' +
      'verified domain is a phishing capability against our own users — including magic links, ' +
      'which are credentials. The api enqueues; the worker sends.'
    );
  }
}

class EnvironmentVariablesValidator {
  @IsOptional()
  IS_WORKER: boolean;

  @IsString()
  @IsOptional()
  @Validate(ResendKeyOnlyOnWorker)
  RESEND_API_KEY: string;

  @IsEmail()
  @IsNotEmpty()
  MAIL_FROM_EMAIL: string;

  @IsString()
  @IsNotEmpty()
  MAIL_FROM_NAME: string;

  @IsEmail()
  @IsOptional()
  MAIL_REPLY_TO: string;

  @IsEmail()
  @IsOptional()
  MAIL_REDIRECT_ALL_TO: string;
}

export function getConfig(): MailConfig {
  const config: MailConfig = {
    fromEmail: process.env.MAIL_FROM_EMAIL as string,
    fromName: process.env.MAIL_FROM_NAME as string,
  };

  if (process.env.RESEND_API_KEY) config.apiKey = process.env.RESEND_API_KEY;
  if (process.env.MAIL_REPLY_TO) config.replyTo = process.env.MAIL_REPLY_TO;
  if (process.env.MAIL_REDIRECT_ALL_TO) {
    config.redirectAllTo = process.env.MAIL_REDIRECT_ALL_TO;
  }

  return config;
}

export default registerAs<MailConfig>('mail', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);
  return getConfig();
});
