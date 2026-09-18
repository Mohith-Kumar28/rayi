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

import { verifySvixSignature } from './svix-signature';
import { WebhookIngestService } from './webhook-ingest.service';

/**
 * Resend's webhook endpoint.
 *
 * It does exactly three things: verify the signature, store the raw delivery,
 * return 200. Interpretation happens elsewhere, later, from the stored row.
 *
 * **Why the handler must be this small.** A webhook endpoint that also does the
 * work has the provider's retry policy wired to our processing time. A slow
 * handler becomes a timeout, a timeout becomes a retry, and a bug becomes a lost
 * delivery once the provider gives up. Here nothing between the signature check
 * and the INSERT can be slow, because there is nothing between them.
 *
 * **No authentication, by design.** The signature IS the authentication, and it
 * is stronger than a session would be: it proves the body was produced by
 * someone holding the signing secret. `@PublicAuth()` keeps the auth guard away;
 * `@Public()` keeps it out of the docs-protected set.
 *
 * Not declared with `@Operation()` because it is not part of the published API.
 * Our OpenAPI document describes what a Rayi client may call; a provider's
 * callback is not that, and putting it there would invite a generated client to
 * call it.
 */
@ApiExcludeController()
@Controller('webhooks')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);

  constructor(
    private readonly ingest: WebhookIngestService,
    private readonly config: ConfigService<GlobalConfig>,
  ) {}

  @Public()
  @PublicAuth()
  @Post('resend')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: true }> {
    const secret = this.config.get('mail.webhookSecret', { infer: true });
    if (!secret) {
      // Fail CLOSED. An endpoint with no secret configured cannot verify
      // anything, and accepting unverified webhooks would let a stranger
      // suppress any address they like — locking users out of their accounts.
      this.logger.error(
        'Resend webhook received but no signing secret is configured. Refusing.',
      );
      throw new UnauthorizedException();
    }

    // The RAW bytes, exactly as received. `request.body` has been parsed, and
    // re-serialising it changes whitespace, number formatting and duplicate keys
    // — see svix-signature.ts. Populated by `rawBody: true` in main.ts.
    const raw = request.rawBody;
    if (!raw) {
      // Refuse rather than verify against a reconstructed body. A signature
      // check over the wrong bytes rejects everything, which would look like an
      // attack rather than a misconfiguration.
      this.logger.error(
        'Resend webhook has no raw body. `rawBody: true` is not set on the application, so the ' +
          'signature can never be verified.',
      );
      throw new UnauthorizedException();
    }
    const body = raw.toString('utf8');

    const headers = request.headers;
    const verification = verifySvixSignature({
      body,
      headers: {
        id: header(headers['svix-id']),
        timestamp: header(headers['svix-timestamp']),
        signature: header(headers['svix-signature']),
      },
      secret,
    });

    if (!verification.ok) {
      // The reason is logged but never returned. Telling a caller WHY their
      // signature failed — wrong secret vs. stale timestamp vs. malformed
      // header — is a free oracle for anyone probing the endpoint.
      this.logger.warn(`Rejected Resend webhook: ${verification.reason}`);
      throw new UnauthorizedException();
    }

    // Past this point the payload is authentic, so parsing it is safe — but only
    // to route and identify it. Everything that acts on the contents re-parses
    // the stored bytes later.
    const parsed = safeParse(body);
    const externalId = header(headers['svix-id']) ?? '';
    const eventType =
      typeof parsed?.['type'] === 'string' ? parsed['type'] : 'unknown';

    const outcome = await this.ingest.store({
      source: 'resend',
      externalId,
      eventType,
      payload: body,
      headers: {
        'svix-id': header(headers['svix-id']) ?? null,
        'svix-timestamp': header(headers['svix-timestamp']) ?? null,
        'svix-signature': header(headers['svix-signature']) ?? null,
      },
    });

    if (!outcome.stored) {
      // A redelivery of something we already have. 200, because from the
      // provider's side it succeeded — anything else teaches it to keep retrying
      // work that is already done.
      this.logger.log(`Resend redelivered ${externalId}; already stored.`);
    }

    return { received: true };
  }
}

/** Fastify gives a header as string | string[]. Take the first. */
function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeParse(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A signed body that is not JSON is still stored — it verified, so Resend
    // sent it, and discarding it would destroy the evidence that they did.
    return null;
  }
}
