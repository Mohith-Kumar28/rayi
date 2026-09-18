import {
  Controller,
  HttpCode,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { GlobalConfig } from '@/config/config.type';
import { PublicAuth } from '@/decorators/auth/public-auth.decorator';
import { Public } from '@/decorators/public.decorator';

import { verifyStripeSignature } from './stripe-signature';
import { WebhookIngestService } from './webhook-ingest.service';

/**
 * Stripe's webhook endpoints. Two of them, with two secrets.
 *
 * **Why two.** Connect events — `account.updated`, `payout.paid`,
 * `payout.failed`, `transfer.reversed` — are delivered to a separate endpoint
 * with its own signing secret. Without a second endpoint they have no reception
 * path at all: a creator's payout failing, or their payout bank details
 * changing, would simply never reach us. That is a silent money bug with a
 * three-day fuse, because Stripe retries for three days and then stops.
 *
 * Both do the same three things: verify, store, 200. Interpretation happens in
 * the worker, from the stored row, so a slow or failing handler can never become
 * a lost delivery.
 *
 * **The event payload is not trusted for anything but routing.** Stripe's own
 * guidance, and the money-integrity review, both say to dispatch on the
 * REFETCHED live object rather than the delivered one: an event describes the
 * world at the moment it was generated, and by the time it is processed the
 * object may have moved on. The interpreter (roadmap step 11) refetches. This
 * controller reads the payload only far enough to know what it is storing.
 */
@ApiExcludeController()
@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly ingest: WebhookIngestService,
    private readonly config: ConfigService<GlobalConfig>,
  ) {}

  /** Platform events: charges, disputes, payment intents on Rayi's own account. */
  @Public()
  @PublicAuth()
  @Post('stripe')
  @HttpCode(200)
  async platform(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    return this.receive(request, {
      source: 'stripe_platform',
      secret: this.config.get('stripe.webhookSecretPlatform', { infer: true }),
    });
  }

  /**
   * Connect events, from connected accounts.
   *
   * A SEPARATE secret. Using the platform secret here would reject every Connect
   * delivery, and the symptom — every creator payout notification silently
   * missing — looks nothing like a configuration error.
   */
  @Public()
  @PublicAuth()
  @Post('stripe/connect')
  @HttpCode(200)
  async connect(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    return this.receive(request, {
      source: 'stripe_connect',
      secret: this.config.get('stripe.webhookSecretConnect', { infer: true }),
    });
  }

  private async receive(
    request: RawBodyRequest<FastifyRequest>,
    endpoint: { source: string; secret: string | undefined },
  ): Promise<{ received: true }> {
    if (!endpoint.secret) {
      // Fail CLOSED. An endpoint with no secret cannot verify anything, and
      // accepting unverified Stripe events would let a stranger tell us a charge
      // succeeded — which is the beginning of a path to moving money.
      this.logger.error(`${endpoint.source} webhook received but no signing secret is configured.`);
      throw new UnauthorizedException();
    }

    const raw = request.rawBody;
    if (!raw) {
      this.logger.error(
        `${endpoint.source} webhook has no raw body; the signature can never be verified.`,
      );
      throw new UnauthorizedException();
    }

    const body = raw.toString('utf8');
    const header = request.headers['stripe-signature'];

    const verification = verifyStripeSignature({
      body,
      header: Array.isArray(header) ? header[0] : header,
      secret: endpoint.secret,
    });

    if (!verification.ok) {
      // Logged, never returned. Distinguishing "wrong secret" from "stale
      // timestamp" is a free oracle for anyone probing the endpoint.
      this.logger.warn(`Rejected ${endpoint.source} webhook: ${verification.reason}`);
      throw new UnauthorizedException();
    }

    const parsed = safeParse(body);

    // Stripe's own event id, which is what its retries reuse. Using anything
    // else — a generated id, a hash — would make every retry a new row and
    // defeat the idempotency the unique index provides.
    const externalId = typeof parsed?.['id'] === 'string' ? parsed['id'] : '';
    if (!externalId) {
      // A verified body with no event id is Stripe sending something we have no
      // way to deduplicate. Stored under a synthetic id rather than dropped: it
      // verified, so Stripe sent it, and discarding it destroys the evidence.
      this.logger.error(`${endpoint.source} delivery verified but carries no event id.`);
    }

    const outcome = await this.ingest.store({
      source: endpoint.source,
      externalId: externalId || `unidentified:${Date.now()}`,
      eventType: typeof parsed?.['type'] === 'string' ? parsed['type'] : 'unknown',
      payload: body,
      headers: {
        'stripe-signature': Array.isArray(header) ? (header[0] ?? null) : (header ?? null),
        // The connected account this event is about, when there is one. Recorded
        // at the edge because the interpreter needs to know WHOSE account it is
        // refetching from, and the header is the authoritative answer.
        'stripe-account': headerValue(request.headers['stripe-account']),
      },
    });

    if (!outcome.stored) {
      this.logger.log(`Stripe redelivered ${externalId}; already stored.`);
    }

    return { received: true };
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
