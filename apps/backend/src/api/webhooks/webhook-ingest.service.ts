import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/database/prisma.service';

/**
 * Stores a verified webhook delivery. Interprets nothing.
 *
 * The split matters. A webhook endpoint that also does the work has the
 * provider's retry policy wired to our processing time: a slow handler becomes a
 * timeout, a timeout becomes a retry, and a bug becomes a lost delivery once the
 * provider gives up. For Stripe that is a three-day fuse on a silent money bug.
 *
 * So: verify the signature, write the row, return 200. Something else reads the
 * row later, in a process the provider cannot reach and cannot time out.
 */

export type IngestOutcome =
  | { readonly stored: true; readonly id: string }
  /** The provider retried a delivery we already have. The normal case, not an error. */
  | { readonly stored: false; readonly id: string; readonly duplicate: true };

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  async store(input: {
    source: string;
    externalId: string;
    eventType: string;
    /** RAW bytes as received. Never re-serialised JSON — see svix-signature.ts. */
    payload: string;
    headers: Record<string, unknown>;
  }): Promise<IngestOutcome> {
    try {
      const event = await this.prisma.webhookEvent.create({
        data: {
          source: input.source,
          externalId: input.externalId,
          eventType: input.eventType,
          payload: input.payload,
          headers: input.headers as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { stored: true, id: event.id };
    } catch (error) {
      // A duplicate is EXPECTED. Providers retry deliveries they already made —
      // on a timeout, on a 5xx, on their own schedule — so the unique index is
      // the idempotency guarantee and hitting it is a normal path.
      //
      // Reported as 200 to the provider, because it succeeded: we have the
      // event. Anything else teaches the provider to keep retrying something
      // that is already done.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.webhookEvent.findFirst({
          where: { source: input.source, externalId: input.externalId },
          select: { id: true },
        });
        if (existing) {
          return { stored: false, id: existing.id, duplicate: true };
        }
      }
      throw error;
    }
  }

  /** Deliveries waiting to be interpreted, oldest first. */
  async pending(source: string, limit = 50) {
    return this.prisma.webhookEvent.findMany({
      where: { source, status: 'pending' },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'processed', processedAt: new Date() },
    });
  }

  /**
   * `ignored` is distinct from `failed`, and the distinction is load-bearing.
   *
   * An event type we do not handle is not a failure — it is a delivery we
   * correctly chose to do nothing with. Marking those `failed` would bury a real
   * failure in a pile of noise, and a failure count nobody trusts is a failure
   * count nobody reads.
   */
  async markIgnored(id: string, reason: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'ignored',
        processedAt: new Date(),
        failureReason: reason.slice(0, 500),
      },
    });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'failed',
        processedAt: new Date(),
        failureReason: reason.slice(0, 500),
      },
    });
    this.logger.error(`Webhook ${id} failed: ${reason}`);
  }
}
