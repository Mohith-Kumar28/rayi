import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';

import { PrismaService as PrismaServiceClass } from '../src/database/prisma.service';
import type { PrismaService } from '../src/database/prisma.service';
import { WebhooksModule } from '../src/api/webhooks/webhooks.module';

/**
 * Stripe's two webhook endpoints.
 *
 * The valuable assertions are about the SPLIT: the platform secret must not
 * verify a Connect delivery, and vice versa. Getting that wrong means every
 * Connect event — `account.updated`, `payout.failed`, `transfer.reversed` — is
 * silently rejected, and the symptom is a creator's payout notification that
 * simply never arrives. Stripe retries for three days and then stops.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

const PLATFORM_SECRET = 'whsec_platform_test_secret';
const CONNECT_SECRET = 'whsec_connect_test_secret';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({
          stripe: {
            webhookSecretPlatform: PLATFORM_SECRET,
            webhookSecretConnect: CONNECT_SECRET,
          },
        }),
      ],
    }),
    WebhooksModule,
  ],
})
class TestStripeApi {}

let app: NestFastifyApplication;

function event(type: string, extra: Record<string, unknown> = {}) {
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `obj_${randomUUID().slice(0, 8)}` } },
    ...extra,
  };
}

function sign(payload: unknown, secret: string, options: { timestamp?: number } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  // The secret AS-IS — not base64-decoded, unlike Svix.
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { body, header: `t=${timestamp},v1=${signature}` };
}

function post(
  url: string,
  signed: { body: string; header: string },
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signed.header,
      ...extraHeaders,
    },
    payload: signed.body,
  });
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  const moduleRef = await Test.createTestingModule({ imports: [TestStripeApi] })
    .overrideProvider(PrismaServiceClass)
    .useValue(prismaService)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    rawBody: true,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('the platform endpoint', () => {
  it('accepts a correctly signed event and stores the raw body', async () => {
    const payload = event('charge.succeeded');
    const signed = sign(payload, PLATFORM_SECRET);

    const response = await post('/webhooks/stripe', signed);
    expect(response.statusCode).toBe(200);

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: payload.id },
    });
    expect(stored.source).toBe('stripe_platform');
    expect(stored.eventType).toBe('charge.succeeded');
    // The bytes, not a re-serialisation. The signature was computed over these.
    expect(stored.payload).toBe(signed.body);
    expect(stored.status).toBe('pending');
  }, 20_000);

  it('keys idempotency on STRIPE’s event id, so a retry stores nothing new', async () => {
    // Stripe retries deliveries it already made. Using a generated id would make
    // every retry a new row and defeat the unique index entirely.
    const payload = event('payment_intent.succeeded');
    const signed = sign(payload, PLATFORM_SECRET);

    expect((await post('/webhooks/stripe', signed)).statusCode).toBe(200);
    expect((await post('/webhooks/stripe', signed)).statusCode).toBe(200);

    expect(await prisma.webhookEvent.count({ where: { externalId: payload.id } })).toBe(1);
  }, 20_000);

  it('rejects an unsigned request', async () => {
    const signed = sign(event('charge.succeeded'), PLATFORM_SECRET);
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: signed.body,
    });
    expect(response.statusCode).toBe(401);
  }, 20_000);

  it('rejects a tampered body', async () => {
    const signed = sign(event('charge.succeeded'), PLATFORM_SECRET);
    const tampered = { ...signed, body: JSON.stringify(event('charge.refunded')) };

    const response = await post('/webhooks/stripe', tampered);
    expect(response.statusCode).toBe(401);
  }, 20_000);

  it('rejects a replay outside the tolerance', async () => {
    const stale = sign(event('charge.succeeded'), PLATFORM_SECRET, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect((await post('/webhooks/stripe', stale)).statusCode).toBe(401);
  }, 20_000);
});

describe('the two endpoints do not share a secret', () => {
  it('REFUSES a Connect delivery signed with the platform secret', async () => {
    // The failure this prevents is entirely silent: every Connect event
    // rejected, so `payout.failed` and `transfer.reversed` never reach us, and
    // nothing about the symptom points at a mismatched secret.
    const signed = sign(event('payout.failed'), PLATFORM_SECRET);
    expect((await post('/webhooks/stripe/connect', signed)).statusCode).toBe(401);
  }, 20_000);

  it('REFUSES a platform delivery signed with the Connect secret', async () => {
    const signed = sign(event('charge.succeeded'), CONNECT_SECRET);
    expect((await post('/webhooks/stripe', signed)).statusCode).toBe(401);
  }, 20_000);

  it('accepts each on its own endpoint', async () => {
    const platform = event('charge.succeeded');
    const connect = event('payout.paid');

    expect((await post('/webhooks/stripe', sign(platform, PLATFORM_SECRET))).statusCode).toBe(200);
    expect(
      (await post('/webhooks/stripe/connect', sign(connect, CONNECT_SECRET))).statusCode,
    ).toBe(200);

    const stored = await prisma.webhookEvent.findMany({
      where: { externalId: { in: [platform.id, connect.id] } },
    });
    expect(stored.find((row) => row.externalId === platform.id)?.source).toBe('stripe_platform');
    expect(stored.find((row) => row.externalId === connect.id)?.source).toBe('stripe_connect');
  }, 20_000);

  it('separates the two sources, so the same event id on both is two rows', async () => {
    // Idempotency is on `(source, externalId)`. Stripe would not normally send
    // the same id to both, but conflating them would let a Connect event
    // suppress a platform one.
    const payload = event('account.updated');

    await post('/webhooks/stripe', sign(payload, PLATFORM_SECRET));
    await post('/webhooks/stripe/connect', sign(payload, CONNECT_SECRET));

    expect(await prisma.webhookEvent.count({ where: { externalId: payload.id } })).toBe(2);
  }, 20_000);
});

describe('the connected account is recorded at the edge', () => {
  it('stores Stripe-Account, because the interpreter needs to know whose account to refetch from', async () => {
    const payload = event('account.updated');
    const signed = sign(payload, CONNECT_SECRET);

    await post('/webhooks/stripe/connect', signed, { 'stripe-account': 'acct_1234567890' });

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: payload.id, source: 'stripe_connect' },
    });
    expect((stored.headers as Record<string, unknown>)['stripe-account']).toBe('acct_1234567890');
  }, 20_000);

  it('records null rather than omitting it when there is no connected account', async () => {
    const payload = event('charge.succeeded');
    await post('/webhooks/stripe', sign(payload, PLATFORM_SECRET));

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: payload.id },
    });
    const headers = stored.headers as Record<string, unknown>;
    expect('stripe-account' in headers).toBe(true);
    expect(headers['stripe-account']).toBeNull();
  }, 20_000);
});

describe('the stored delivery is evidence', () => {
  it('refuses to let a Stripe payload be edited', async () => {
    const payload = event('charge.dispute.created');
    await post('/webhooks/stripe', sign(payload, PLATFORM_SECRET));

    // A dispute about what Stripe told us is settled by replaying the signature
    // over the stored body. If the body can change, that proof is gone.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "webhook_event" SET payload = '{"type":"nothing"}' WHERE "externalId" = $1`,
        payload.id,
      ),
    ).rejects.toThrow(/evidence/);
  }, 20_000);
});
