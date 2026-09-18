import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';

import { ResendWebhookService } from '../src/api/webhooks/resend-webhook.service';
import { WebhooksWorkerModule } from '../src/api/webhooks/webhooks-worker.module';
import { WebhooksModule } from '../src/api/webhooks/webhooks.module';
import { AuditModule } from '../src/audit/audit.module';
import type { PrismaService } from '../src/database/prisma.service';
import { PrismaService as PrismaServiceClass } from '../src/database/prisma.service';

/**
 * The Resend webhook, end to end.
 *
 * The valuable assertions here are the ones about what does NOT happen: an
 * unsigned request cannot suppress an address, a replayed one cannot be
 * processed twice, and a transient bounce cannot lock a user out of their own
 * account.
 *
 * Suppression is an availability control pointed at our own users. Getting it
 * wrong in the permissive direction costs deliverability; getting it wrong in
 * the aggressive direction means a creator cannot sign in and cannot tell us,
 * because the way they would tell us is email.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const SECRET = `whsec_${Buffer.from('resend-webhook-test-signing-key!!').toString('base64')}`;

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        () => ({
          mail: {
            webhookSecret: SECRET,
            fromEmail: 'no-reply@rayi.test',
            fromName: 'Rayi',
          },
        }),
      ],
    }),
    // Both halves, because this test exercises the whole path. In production
    // they are in DIFFERENT processes: the controller in the api, the
    // interpreter in the worker.
    WebhooksModule,
    WebhooksWorkerModule,
    AuditModule,
  ],
})
class TestWebhookApi {}

let app: NestFastifyApplication;
let interpreter: ResendWebhookService;

const run = randomUUID().slice(0, 8);

function address(label: string): string {
  return `${run}-${label}@bounce.test`;
}

/** Builds a correctly signed delivery. */
function signed(
  payload: unknown,
  options: { id?: string; timestamp?: number } = {},
) {
  const body = JSON.stringify(payload);
  const id = options.id ?? `msg_${randomUUID()}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace('whsec_', ''), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    id,
  };
}

function post(
  delivery: ReturnType<typeof signed>,
  headerOverrides: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/resend',
    headers: { ...delivery.headers, ...headerOverrides },
    payload: delivery.body,
  });
}

function bounce(email: string, type = 'Permanent') {
  return {
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: {
      email_id: randomUUID(),
      to: [email],
      bounce: { type, subType: 'General' },
    },
  };
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  const moduleRef = await Test.createTestingModule({
    imports: [TestWebhookApi],
  })
    .overrideProvider(PrismaServiceClass)
    .useValue(prismaService)
    .compile();

  // `rawBody: true` exactly as main.ts sets it. Without it the raw bytes are
  // gone and no signature can ever verify — so this option is part of what is
  // under test, not test scaffolding.
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    {
      rawBody: true,
    },
  );

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  interpreter = app.get(ResendWebhookService);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('a request that is not properly signed is refused', () => {
  it('rejects a body that does not match its signature', async () => {
    const delivery = signed(bounce(address('tampered')));
    const tampered = {
      ...delivery,
      body: JSON.stringify(bounce(address('someone-else'))),
    };

    const response = await post(tampered);
    expect(response.statusCode).toBe(401);

    // Nothing was stored, so nothing can be interpreted later.
    expect(
      await prisma.webhookEvent.count({ where: { externalId: delivery.id } }),
    ).toBe(0);
  }, 20_000);

  it('rejects a request with no signature headers at all', async () => {
    const delivery = signed(bounce(address('unsigned')));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/resend',
      headers: { 'content-type': 'application/json' },
      payload: delivery.body,
    });
    expect(response.statusCode).toBe(401);
  }, 20_000);

  it('rejects a replayed request once the timestamp is stale', async () => {
    const stale = signed(bounce(address('stale')), {
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    });
    expect((await post(stale)).statusCode).toBe(401);
  }, 20_000);

  it('never says WHY it refused, so the endpoint is not an oracle', async () => {
    // Distinguishing "wrong secret" from "stale timestamp" from "malformed
    // header" hands a prober a free signal about how to get closer.
    const delivery = signed(bounce(address('oracle')));
    const noSig = await post(delivery, { 'svix-signature': 'v1,AAAA' });
    const stale = await post(
      signed(bounce(address('oracle2')), {
        timestamp: Math.floor(Date.now() / 1000) - 7200,
      }),
    );

    expect(noSig.statusCode).toBe(stale.statusCode);
    expect(noSig.payload).toBe(stale.payload);
  }, 20_000);

  it('CANNOT suppress an address without a valid signature', async () => {
    // The attack this endpoint exists to refuse. Suppressing an address locks
    // its owner out of sign-in, so an unauthenticated suppression is an
    // unauthenticated account lockout.
    const victim = address('victim');
    const delivery = signed(bounce(victim));

    await post(delivery, {
      'svix-signature': 'v1,' + Buffer.from('x'.repeat(32)).toString('base64'),
    });
    await interpreter.processPending();

    expect(
      await prisma.emailSuppression.findFirst({ where: { email: victim } }),
    ).toBeNull();
  }, 20_000);
});

describe('a signed delivery is stored, then interpreted', () => {
  it('returns 200 and stores the RAW body', async () => {
    const payload = bounce(address('stored'));
    const delivery = signed(payload);

    const response = await post(delivery);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ received: true });

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: delivery.id },
    });

    // The bytes, not a re-serialisation. The signature was computed over these,
    // so anything else destroys our ability to prove what Resend sent.
    expect(stored.payload).toBe(delivery.body);
    expect(stored.source).toBe('resend');
    expect(stored.eventType).toBe('email.bounced');
    expect(stored.status).toBe('pending');
  }, 20_000);

  it('does NOT act on it during the request', async () => {
    // The endpoint verifies, stores and returns. A handler that also did the
    // work would have Resend's timeout wired to our processing time.
    const email = address('deferred');
    await post(signed(bounce(email)));

    expect(
      await prisma.emailSuppression.findFirst({ where: { email } }),
    ).toBeNull();

    await interpreter.processPending();
    expect(
      await prisma.emailSuppression.findFirst({ where: { email } }),
    ).not.toBeNull();
  }, 20_000);

  it('treats a redelivery as success, and stores it once', async () => {
    // Providers retry deliveries they already made. Anything other than 200
    // teaches them to keep retrying work that is already done.
    const delivery = signed(bounce(address('redelivered')));

    expect((await post(delivery)).statusCode).toBe(200);
    expect((await post(delivery)).statusCode).toBe(200);

    expect(
      await prisma.webhookEvent.count({ where: { externalId: delivery.id } }),
    ).toBe(1);
  }, 20_000);
});

describe('what a bounce actually does', () => {
  it('suppresses on a PERMANENT bounce', async () => {
    const email = address('permanent');
    await post(signed(bounce(email, 'Permanent')));
    await interpreter.processPending();

    const suppression = await prisma.emailSuppression.findFirstOrThrow({
      where: { email },
    });
    expect(suppression.reason).toBe('hard_bounce');
    expect(suppression.liftedAt).toBeNull();
  }, 20_000);

  it('does NOT suppress on a transient bounce', async () => {
    // A full mailbox, a greylist, a server briefly down. Suppressing on these
    // would lock a creator out over a mail server that was busy for an hour —
    // and they could not tell us, because the way they tell us is email.
    const email = address('transient');
    await post(signed(bounce(email, 'Transient')));
    await interpreter.processPending();

    expect(
      await prisma.emailSuppression.findFirst({ where: { email } }),
    ).toBeNull();
  }, 20_000);

  it('does not suppress on an UNKNOWN bounce type, failing to the safe side', async () => {
    // One more email to a dead address costs deliverability. A wrongly
    // suppressed address costs a user their account.
    const email = address('unknown-type');
    await post(signed(bounce(email, 'SomethingNew')));
    await interpreter.processPending();

    expect(
      await prisma.emailSuppression.findFirst({ where: { email } }),
    ).toBeNull();
  }, 20_000);

  it('suppresses on a spam complaint', async () => {
    const email = address('complaint');
    await post(
      signed({
        type: 'email.complained',
        data: { email_id: randomUUID(), to: [email] },
      }),
    );
    await interpreter.processPending();

    const suppression = await prisma.emailSuppression.findFirstOrThrow({
      where: { email },
    });
    expect(suppression.reason).toBe('complaint');
  }, 20_000);

  it('lower-cases the address, so case cannot bypass a suppression', async () => {
    const email = address('MixedCase');
    await post(signed(bounce(email)));
    await interpreter.processPending();

    const suppression = await prisma.emailSuppression.findFirstOrThrow({
      where: { email: email.toLowerCase() },
    });
    expect(suppression.email).toBe(email.toLowerCase());
  }, 20_000);

  it('keeps the FIRST suppression rather than overwriting it', async () => {
    // The first one explains why mail stopped. A later duplicate event
    // overwriting its reason and timestamp would rewrite that history.
    const email = address('twice');
    await post(signed(bounce(email)));
    await interpreter.processPending();
    const first = await prisma.emailSuppression.findFirstOrThrow({
      where: { email },
    });

    await post(signed({ type: 'email.complained', data: { to: [email] } }));
    await interpreter.processPending();

    const rows = await prisma.emailSuppression.findMany({ where: { email } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('hard_bounce');
    expect(rows[0]?.suppressedAt).toEqual(first.suppressedAt);
  }, 20_000);

  it('records an audit row, so support can explain why mail stopped', async () => {
    const email = address('audited');
    await post(signed(bounce(email)));
    await interpreter.processPending();

    const events = await prisma.$queryRawUnsafe<
      Array<{ action: string; subject_id: string }>
    >(
      `SELECT action, subject_id FROM audit.event
        WHERE action = 'email.suppressed' AND subject_id = $1`,
      email.toLowerCase(),
    );
    expect(events).toHaveLength(1);
  }, 20_000);
});

describe('events we deliberately do not act on', () => {
  it.each([['email.delivered'], ['email.sent'], ['email.delivery_delayed']])(
    'marks %s as ignored, not failed',
    async (type) => {
      // `ignored` is a delivery we correctly chose to do nothing with. Marking
      // those `failed` would bury real failures in noise, and a failure count
      // nobody trusts is a failure count nobody reads.
      const delivery = signed({ type, data: { to: [address(type)] } });
      await post(delivery);
      await interpreter.processPending();

      const stored = await prisma.webhookEvent.findFirstOrThrow({
        where: { externalId: delivery.id },
      });
      expect(stored.status).toBe('ignored');
    },
    20_000,
  );

  it('does not suppress on a delayed delivery', async () => {
    // `delivery_delayed` means the provider is still trying.
    const email = address('delayed');
    await post(
      signed({ type: 'email.delivery_delayed', data: { to: [email] } }),
    );
    await interpreter.processPending();
    expect(
      await prisma.emailSuppression.findFirst({ where: { email } }),
    ).toBeNull();
  }, 20_000);
});

describe('the stored delivery is evidence', () => {
  it('refuses to let the payload be edited', async () => {
    const delivery = signed(bounce(address('immutable')));
    await post(delivery);
    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: delivery.id },
    });

    // If the stored body can be changed, "we can prove what the provider told
    // us" stops being true — and that proof is what settles a dispute.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "webhook_event" SET payload = '{"type":"nothing"}' WHERE id = $1`,
        stored.id,
      ),
    ).rejects.toThrow(/evidence/);
  }, 20_000);

  it('refuses to let a delivery be deleted', async () => {
    const delivery = signed(bounce(address('undeletable')));
    await post(delivery);

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "webhook_event" WHERE "externalId" = $1`,
        delivery.id,
      ),
    ).rejects.toThrow(/append-only/);
  }, 20_000);

  it('still allows the processing columns to be written', async () => {
    // Immutability is column-level, not table-level: a worker must be able to
    // mark a row processed.
    const delivery = signed(bounce(address('markable')));
    await post(delivery);
    await interpreter.processPending();

    const stored = await prisma.webhookEvent.findFirstOrThrow({
      where: { externalId: delivery.id },
    });
    expect(stored.status).toBe('processed');
    expect(stored.processedAt).not.toBeNull();
  }, 20_000);
});
