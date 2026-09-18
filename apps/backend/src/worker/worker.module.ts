import { Module } from '@nestjs/common';

import { WebhooksWorkerModule } from '@/api/webhooks/webhooks-worker.module';
import { TreasuryWorkerModule } from '@/treasury/treasury-worker.module';

import { PlatformSnapshotModule } from './snapshot/platform-snapshot.module';

import { EmailQueueModule } from './queues/email/email.module';

/**
 * The worker process's module graph.
 *
 * `TreasuryWorkerModule` is bound HERE and nowhere else. `AppModule.main()` —
 * the public API — never imports it, so the api process has no ledger-posting
 * provider to resolve even if some future controller asked for one.
 *
 * Two different queues, deliberately:
 *
 *   `EmailQueueModule`      BullMQ over Redis. At-least-once is fine; a
 *                           duplicate email is an annoyance.
 *   `TreasuryWorkerModule`  Postgres-backed. A duplicate is money, and Redis
 *                           cannot join the transaction that writes the intent.
 *
 * `WebhooksWorkerModule` interprets deliveries the api stored. It lives here and
 * not in the api so that a slow or failing interpretation cannot become a
 * provider timeout, and therefore cannot become a lost delivery.
 */
@Module({
  imports: [
    EmailQueueModule,
    TreasuryWorkerModule,
    WebhooksWorkerModule,
    PlatformSnapshotModule,
  ],
})
export class WorkerModule {}
