import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { ResendWebhookPoller } from './resend-webhook.poller';
import { ResendWebhookService } from './resend-webhook.service';
import { WebhookIngestModule } from './webhook-ingest.module';

/**
 * The webhook INTERPRETING half. Worker side, never in the api's graph.
 *
 * Nothing here is reachable from an HTTP request, so a slow or failing
 * interpretation cannot become a provider timeout — and therefore cannot become
 * a lost delivery.
 */
@Module({
  imports: [PrismaModule, WebhookIngestModule],
  providers: [ResendWebhookService, ResendWebhookPoller],
  exports: [ResendWebhookService],
})
export class WebhooksWorkerModule {}
