import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ResendWebhookService } from './resend-webhook.service';

/**
 * Drains pending Resend deliveries.
 *
 * A plain poll, deliberately — there is no notification to wait for, because the
 * row was written by a different process and nothing tells this one about it.
 * Adding a `pg_notify` from the webhook controller would be a latency
 * optimisation on a path where latency does not matter: nobody is waiting on a
 * bounce being recorded, and the cost of a suppression landing thirty seconds
 * late is zero.
 *
 * What DOES matter is that it always runs. A pending delivery nobody interprets
 * is a bounce we never see, which means we keep emailing a dead address — and
 * that damages deliverability for every other user.
 */

const POLL_INTERVAL_MS = 30_000;

@Injectable()
export class ResendWebhookPoller
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ResendWebhookPoller.name);

  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly resend: ResendWebhookService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.timer.unref();
    void this.drain();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    // Guarded against overlap so a slow batch does not stack up behind itself.
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const result = await this.resend.processPending();
      if (result.processed > 0 || result.failed > 0) {
        this.logger.log(
          `Resend webhooks: ${result.processed} processed, ${result.ignored} ignored, ` +
            `${result.failed} failed.`,
        );
      }
    } catch (error) {
      // Swallowed so one bad batch does not take the poller down. The failure is
      // already recorded on each row, and the row is the record of what happened.
      this.logger.error(
        `Resend webhook drain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
