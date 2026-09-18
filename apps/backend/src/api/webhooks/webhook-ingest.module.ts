import { Module } from '@nestjs/common';

import { PrismaModule } from '@/database/prisma.module';

import { WebhookIngestService } from './webhook-ingest.service';

/**
 * Storing and reading webhook deliveries. Interprets nothing.
 *
 * Its own module because BOTH halves need it and neither may pull in the other:
 * the controller (api) writes deliveries, the interpreter (worker) reads them,
 * and the whole point of the split is that the thing which ACTS is not reachable
 * from the thing that LISTENS.
 */
@Module({
  imports: [PrismaModule],
  providers: [WebhookIngestService],
  exports: [WebhookIngestService],
})
export class WebhookIngestModule {}
