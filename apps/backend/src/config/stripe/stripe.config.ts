import validateConfig from '@/utils/config/validate-config';
import { registerAs } from '@nestjs/config';
import { IsOptional, IsString, Matches, Validate, ValidatorConstraint } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';
import process from 'node:process';

import type { StripeConfig } from './stripe-config.type';

/**
 * Stripe credentials, scoped by the role of the running process.
 *
 * This is the file that makes the architecture's central claim true rather than
 * aspirational: an RCE in the internet-reachable `api` process yields no ability
 * to move money, BECAUSE that process cannot hold a full Stripe secret key.
 *
 * A comment saying so is not a control. A boot failure is.
 *
 *   api       — may hold a RESTRICTED key (`rk_`) scoped to Checkout Sessions
 *               and Account Links. It cannot create transfers.
 *   webhooks  — holds no Stripe credential at all. It verifies signatures and
 *               stores raw events; refetching authoritative state is the
 *               worker's job.
 *   worker    — the only process permitted a full secret key, and the only one
 *               with no listening socket, no target group and no inbound
 *               security-group rule.
 *
 * `IS_WORKER` is the boilerplate's existing role flag, reused here so there is
 * one notion of "which process am I" rather than two that can disagree.
 */

/** `sk_live_…` / `sk_test_…` — full account access. */
const STRIPE_SECRET_KEY = /^sk_(live|test)_/;

@ValidatorConstraint({ name: 'stripeSecretKeyOnlyOnWorker', async: false })
class StripeSecretKeyOnlyOnWorker implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string' || !STRIPE_SECRET_KEY.test(value)) return true;
    const env = args.object as { IS_WORKER?: unknown };
    // Only the worker may carry a full secret key.
    return env.IS_WORKER === true || env.IS_WORKER === 'true';
  }

  defaultMessage(): string {
    return (
      'A full Stripe secret key (sk_) may only be present on the worker process. ' +
      'The api and webhooks processes are internet-reachable, and the isolation argument depends ' +
      'on a compromise of them yielding no ability to move money. ' +
      'Use STRIPE_RESTRICTED_KEY (rk_) scoped to Checkout Sessions and Account Links instead.'
    );
  }
}

class EnvironmentVariablesValidator {
  @IsOptional()
  IS_WORKER: boolean;

  @IsString()
  @IsOptional()
  @Validate(StripeSecretKeyOnlyOnWorker)
  STRIPE_SECRET_KEY: string;

  @IsString()
  @IsOptional()
  @Matches(/^rk_(live|test)_/, {
    message: 'STRIPE_RESTRICTED_KEY must be a restricted key beginning rk_live_ or rk_test_.',
  })
  STRIPE_RESTRICTED_KEY: string;

  /**
   * Two endpoints, two secrets. Connect events — account.updated, payout.paid,
   * payout.failed, transfer.reversed — arrive on a separate endpoint with its own
   * secret. Without it they have no reception path at all, which is a silent
   * failure with a three-day fuse (Stripe's retry window).
   */
  @IsString()
  @IsOptional()
  STRIPE_WEBHOOK_SECRET_PLATFORM: string;

  @IsString()
  @IsOptional()
  STRIPE_WEBHOOK_SECRET_CONNECT: string;
}

export default registerAs<StripeConfig>('stripe', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    secretKey: process.env.STRIPE_SECRET_KEY,
    restrictedKey: process.env.STRIPE_RESTRICTED_KEY,
    webhookSecretPlatform: process.env.STRIPE_WEBHOOK_SECRET_PLATFORM,
    webhookSecretConnect: process.env.STRIPE_WEBHOOK_SECRET_CONNECT,
  };
});
