import { Module } from '@nestjs/common';

import { ResendWebhookController } from './resend-webhook.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { WebhookIngestModule } from './webhook-ingest.module';

/**
 * The webhook RECEIVING surface. API side.
 *
 * Contains the controller and nothing that interprets. A delivery is verified,
 * stored and acknowledged; `WebhooksWorkerModule` reads it later, in the worker.
 *
 * The split mirrors `TreasuryModule` / `TreasuryWorkerModule` and exists for the
 * same reason: a handler that also did the work would have the provider's
 * timeout wired to our processing time, so a slow interpreter becomes a retry
 * and a bug becomes a lost delivery.
 */
@Module({
  imports: [WebhookIngestModule],
  controllers: [ResendWebhookController, StripeWebhookController],
})
export class WebhooksModule {}
