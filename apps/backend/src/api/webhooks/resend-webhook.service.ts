import { Injectable, Logger } from '@nestjs/common';

import { AuditService } from '@/audit/audit.service';
import { AuditAction } from '@/audit/audit.types';
import { PrismaService } from '@/database/prisma.service';

import {
  isPermanentBounce,
  recipientsOf,
  ResendEvent,
  SuppressionReason,
  type ResendPayload,
} from './resend-events';
import { WebhookIngestService } from './webhook-ingest.service';

/**
 * Interprets stored Resend deliveries.
 *
 * Runs after ingestion, from the stored row, so nothing here is on the
 * provider's timeout budget. It re-parses the raw payload rather than being
 * handed a parsed object, because the raw bytes are what the signature covered
 * and they are the only thing we can prove we received.
 */
@Injectable()
export class ResendWebhookService {
  private readonly logger = new Logger(ResendWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: WebhookIngestService,
    private readonly audit: AuditService,
  ) {}

  /** Processes every pending Resend delivery. Safe to run repeatedly. */
  async processPending(
    limit = 50,
  ): Promise<{ processed: number; ignored: number; failed: number }> {
    const events = await this.ingest.pending('resend', limit);
    let processed = 0;
    let ignored = 0;
    let failed = 0;

    for (const event of events) {
      try {
        const handled = await this.handle(event.id, event.payload);
        if (handled) {
          await this.ingest.markProcessed(event.id);
          processed += 1;
        } else {
          await this.ingest.markIgnored(
            event.id,
            `unhandled_type:${event.eventType}`,
          );
          ignored += 1;
        }
      } catch (error) {
        await this.ingest.markFailed(
          event.id,
          error instanceof Error ? error.message : String(error),
        );
        failed += 1;
      }
    }

    return { processed, ignored, failed };
  }

  /** Returns false when the event type is one we deliberately do not act on. */
  private async handle(eventId: string, rawPayload: string): Promise<boolean> {
    let payload: ResendPayload;
    try {
      payload = JSON.parse(rawPayload) as ResendPayload;
    } catch {
      // Stored but unparseable. The signature verified, so this came from Resend
      // — which makes it worth failing loudly rather than ignoring.
      throw new Error('payload is not valid JSON');
    }

    switch (payload.type) {
      case ResendEvent.Bounced:
        return this.onBounce(eventId, payload);

      case ResendEvent.Complained:
        return this.onComplaint(eventId, payload);

      case ResendEvent.Sent:
      case ResendEvent.Delivered:
      case ResendEvent.DeliveryDelayed:
        // Recorded by virtue of being stored. Nothing to do — and `delivery_delayed`
        // in particular must NOT suppress: a delayed message is one the provider
        // is still trying.
        return false;

      default:
        return false;
    }
  }

  private async onBounce(
    eventId: string,
    payload: ResendPayload,
  ): Promise<boolean> {
    if (!isPermanentBounce(payload)) {
      // A full mailbox, a greylist, a server that was briefly down. Suppressing
      // on these would lock a creator out over a mail server that was busy for
      // an hour — and they could not tell us, because the way they tell us is
      // email.
      this.logger.log(
        `Transient bounce for event ${eventId}; not suppressing.`,
      );
      return true;
    }

    for (const email of recipientsOf(payload)) {
      await this.suppress(email, SuppressionReason.HardBounce, eventId, {
        bounceType: payload.data?.bounce?.type ?? null,
        bounceSubType: payload.data?.bounce?.subType ?? null,
      });
    }
    return true;
  }

  private async onComplaint(
    eventId: string,
    payload: ResendPayload,
  ): Promise<boolean> {
    for (const email of recipientsOf(payload)) {
      await this.suppress(email, SuppressionReason.Complaint, eventId, {});
    }
    return true;
  }

  /**
   * Adds an address to the suppression list, idempotently.
   *
   * An address already suppressed is left alone rather than having its reason or
   * timestamp overwritten: the FIRST suppression is the one that explains why
   * mail stopped, and a later duplicate event would otherwise rewrite that
   * history.
   */
  private async suppress(
    email: string,
    reason: string,
    webhookEventId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const existing = await this.prisma.emailSuppression.findFirst({
      where: { email, liftedAt: null },
      select: { id: true },
    });

    if (existing) return;

    await this.prisma.emailSuppression.create({
      data: { email, reason, webhookEventId },
    });

    this.logger.warn(`Suppressed ${maskEmail(email)} (${reason}).`);

    // Audited, because a suppressed address is a user who can no longer sign in.
    // When they contact support, "why did mail stop" must be answerable.
    await this.audit.record({
      action: AuditAction.EmailSuppressed,
      subjectType: 'email',
      subjectId: email,
      data: { reason, webhookEventId, ...detail },
    });
  }
}

/**
 * `jordan@acme.com` -> `j****n@acme.com`.
 *
 * The domain is the useful part in a log — it says whether one provider is
 * rejecting everything — and the local part is the identifying one.
 */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  if (local.length <= 2) return `**@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}
