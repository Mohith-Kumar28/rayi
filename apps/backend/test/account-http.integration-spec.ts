import { getQueueToken } from '@nestjs/bullmq';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AccountModule } from '../src/api/account/account.module';
import { AuditModule } from '../src/audit/audit.module';
import { StepUpModule } from '../src/auth/step-up/step-up.module';
import {
  decodeBase32,
  DEFAULT_PERIOD,
  generateAt,
} from '../src/auth/step-up/totp';
import { AuthorizationModule } from '../src/authorization/authorization.module';
import { Queue } from '../src/constants/job.constant';
import type { PrismaService } from '../src/database/prisma.service';
import { PrismaService as PrismaServiceClass } from '../src/database/prisma.service';
import { PermissionGuard } from '../src/guards/permission.guard';

/**
 * The account surface that replaces the blocked Better Auth endpoints.
 *
 * The thing actually under test is the **scoping**. `access: { kind: 'self' }`
 * means the guard only checks that you are signed in — it cannot answer "is this
 * row yours", because that is a question about a row it has not loaded. So the
 * handler must carry the user id in every WHERE clause, and these tests are what
 * make that a checked property rather than a convention.
 *
 * Every one of the "another user's" cases would have been a real vulnerability
 * in a version of this code that looked completely reasonable.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;

/**
 * Stands in for `AuthGuard`, attaching the same shape it attaches. The session
 * comes from a header instead of a cookie; everything downstream is real.
 */
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      session?: unknown;
    }>();
    const userId = request.headers['x-test-user'];
    const token = request.headers['x-test-token'];
    request.session = userId
      ? { user: { id: userId }, session: { token } }
      : undefined;
    return true;
  }
}

/** Records what would have been emailed, so the tests can assert on it. */
const enqueued: Array<{ name: string; data: Record<string, unknown> }> = [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [() => ({ app: { url: 'https://app.rayi.test' } })],
    }),
    AccountModule,
    AuditModule,
    AuthorizationModule,
    StepUpModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: StubAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
class TestAccountApi {}

let app: NestFastifyApplication;

const run = randomUUID().slice(0, 8);
let alice: string;
let bob: string;
let aliceCurrentToken: string;
let aliceOtherSessionId: string;
let bobSessionId: string;

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-${label}@test.local`,
      username: `${run}-${label}`,
      isEmailVerified: true,
    },
  });
  return user.id;
}

async function makeSession(
  userId: string,
  token: string,
  ip = '203.0.113.5',
): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt: new Date(Date.now() + 86_400_000),
      ipAddress: ip,
      userAgent: 'test-agent',
    },
  });
  return session.id;
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  alice = await makeUser('alice');
  bob = await makeUser('bob');

  aliceCurrentToken = `tok-${run}-alice-current`;
  await makeSession(alice, aliceCurrentToken);
  aliceOtherSessionId = await makeSession(
    alice,
    `tok-${run}-alice-laptop`,
    '198.51.100.9',
  );
  bobSessionId = await makeSession(bob, `tok-${run}-bob`);

  const moduleRef = await Test.createTestingModule({
    imports: [TestAccountApi],
  })
    .overrideProvider(PrismaServiceClass)
    .useValue(prismaService)
    // Redis is not part of what this test is about. The queue is replaced with a
    // recorder so the assertions can be about WHAT would be sent.
    .overrideProvider(getQueueToken(Queue.Email))
    .useValue({
      add: (name: string, data: Record<string, unknown>) => {
        enqueued.push({ name, data });
        return Promise.resolve();
      },
    })
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { user?: string; token?: string; body?: unknown } = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      // Only when there IS a body. Fastify rejects a JSON content-type with an
      // empty body as 400 (FST_ERR_CTP_EMPTY_JSON_BODY), which is correct
      // behaviour and exactly what a real client does not do.
      ...(options.body !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.user ? { 'x-test-user': options.user } : {}),
      ...(options.token ? { 'x-test-token': options.token } : {}),
    },
    ...(options.body !== undefined
      ? { payload: options.body as Record<string, unknown> }
      : {}),
  });
}

describe('listing your own sessions', () => {
  it('returns only your own, and marks the current one', async () => {
    const response = await call('GET', '/v1/me/sessions', {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as {
      sessions: Array<{
        sessionId: string;
        current: boolean;
        ipAddress: string | null;
      }>;
    };

    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(body.sessions.map((session) => session.sessionId)).not.toContain(
      bobSessionId,
    );
  }, 20_000);

  it('NEVER returns a session token', async () => {
    // A list endpoint that returned tokens would turn "show me my devices" into
    // "hand me a credential for each of them", and an XSS on that page would
    // harvest every one.
    const response = await call('GET', '/v1/me/sessions', {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.payload).not.toContain(aliceCurrentToken);
    expect(response.payload).not.toContain('token');
  }, 20_000);

  it('refuses an unauthenticated caller', async () => {
    expect((await call('GET', '/v1/me/sessions')).statusCode).toBe(401);
  }, 20_000);
});

describe('revoking a session', () => {
  it('refuses to revoke ANOTHER user’s session, with 404', async () => {
    // The vulnerability this prevents: a session id is not a secret — it appears
    // in the owner's own list — so revoking by id alone would let any signed-in
    // user sign out any other.
    const response = await call('DELETE', `/v1/me/sessions/${bobSessionId}`, {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.statusCode).toBe(404);

    // And Bob is still signed in.
    const still = await prisma.session.findUnique({
      where: { id: bobSessionId },
    });
    expect(still).not.toBeNull();
  }, 20_000);

  it('404s an id that does not exist, indistinguishably', async () => {
    const response = await call('DELETE', '/v1/me/sessions/does-not-exist', {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.statusCode).toBe(404);
  }, 20_000);

  it('revokes your own, and records it in the audit log', async () => {
    const response = await call(
      'DELETE',
      `/v1/me/sessions/${aliceOtherSessionId}`,
      {
        user: alice,
        token: aliceCurrentToken,
      },
    );
    expect(response.statusCode).toBe(204);

    expect(
      await prisma.session.findUnique({ where: { id: aliceOtherSessionId } }),
    ).toBeNull();

    const events = await prisma.$queryRawUnsafe<
      Array<{ action: string; subject_id: string }>
    >(
      `SELECT action, subject_id FROM audit.event
        WHERE actor_user_id = $1 ORDER BY seq DESC LIMIT 1`,
      alice,
    );
    expect(events[0]?.action).toBe('session.revoked');
    expect(events[0]?.subject_id).toBe(aliceOtherSessionId);
  }, 20_000);
});

describe('signing out everywhere else', () => {
  it('keeps the current session alive', async () => {
    // Signing the user out of the device they are using, at the moment they are
    // securing their account, forces them back through the same email an
    // attacker may control.
    await makeSession(alice, `tok-${run}-alice-phone`);
    await makeSession(alice, `tok-${run}-alice-tablet`);

    const response = await call('POST', '/v1/me/sessions/revoke-others', {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ revoked: 2 });

    const remaining = await prisma.session.findMany({
      where: { userId: alice },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.token).toBe(aliceCurrentToken);
  }, 20_000);

  it('does not touch another user’s sessions', async () => {
    const bobSessions = await prisma.session.findMany({
      where: { userId: bob },
    });
    expect(bobSessions.length).toBeGreaterThan(0);
  }, 20_000);

  it('refuses when the current session token is unknown', async () => {
    // Without knowing which session is current, "revoke the others" cannot be
    // answered safely, and guessing would sign the user out of the device they
    // are using.
    const response = await call('POST', '/v1/me/sessions/revoke-others', {
      user: alice,
    });
    expect(response.statusCode).toBe(401);
  }, 20_000);
});

describe('updating your profile', () => {
  it('updates the allowlisted fields and audits which ones', async () => {
    const response = await call('PATCH', '/v1/me/profile', {
      user: alice,
      token: aliceCurrentToken,
      body: { firstName: 'Alice', bio: 'Skincare brand lead' },
    });
    expect(response.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice } });
    expect(user.firstName).toBe('Alice');
    expect(user.bio).toBe('Skincare brand lead');

    const events = await prisma.$queryRawUnsafe<
      Array<{ action: string; data: unknown }>
    >(
      `SELECT action, data FROM audit.event WHERE actor_user_id = $1 ORDER BY seq DESC LIMIT 1`,
      alice,
    );
    expect(events[0]?.action).toBe('account.profile_updated');
    // WHICH fields changed, not what they changed to. A bio is user-authored
    // content and the audit log is not a second copy of it.
    expect(events[0]?.data).toEqual({ fields: ['bio', 'firstName'] });
    expect(JSON.stringify(events[0]?.data)).not.toContain('Skincare');
  }, 20_000);

  it('ignores fields outside the allowlist rather than writing them', async () => {
    // Better Auth's /update-user takes a partial user object, which is how
    // `role`, `twoFactorEnabled` or `isEmailVerified` become writable by anyone
    // holding a session. The contract schema strips them before the handler runs.
    const response = await call('PATCH', '/v1/me/profile', {
      user: alice,
      token: aliceCurrentToken,
      body: {
        firstName: 'Alice',
        role: 'Admin',
        isEmailVerified: true,
        email: 'evil@test.local',
      },
    });
    expect(response.statusCode).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice } });
    expect(user.role).toBe('User');
    expect(user.email).toBe(`${run}-alice@test.local`);
  }, 20_000);

  it('rejects a body with nothing updatable in it', async () => {
    const response = await call('PATCH', '/v1/me/profile', {
      user: alice,
      token: aliceCurrentToken,
      body: { role: 'Admin' },
    });
    expect(response.statusCode).toBe(403);
  }, 20_000);

  it('rejects a bio longer than the contract allows', async () => {
    const response = await call('PATCH', '/v1/me/profile', {
      user: alice,
      token: aliceCurrentToken,
      body: { bio: 'x'.repeat(2001) },
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);
});

describe('your own activity', () => {
  it('returns your events and nobody else’s', async () => {
    const response = await call('GET', '/v1/me/activity', {
      user: alice,
      token: aliceCurrentToken,
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as {
      events: Array<{ action: string }>;
    };
    expect(body.events.length).toBeGreaterThan(0);

    const bobResponse = await call('GET', '/v1/me/activity', { user: bob });
    const bobBody = JSON.parse(bobResponse.payload) as { events: unknown[] };
    // Bob has caused no events, so he sees none — rather than seeing Alice's.
    expect(bobBody.events).toEqual([]);
  }, 20_000);
});

describe('the email-change route over HTTP', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';

  async function enrol(userId: string): Promise<void> {
    await prisma.twoFactor.create({ data: { userId, secret: SECRET } });
    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });
  }

  function code(): string {
    return generateAt(
      decodeBase32(SECRET)!,
      Math.floor(Date.now() / 1000 / DEFAULT_PERIOD),
    );
  }

  it('sends the WARNING to the old address before the confirmation to the new one', async () => {
    // Order matters. If only one of the two can be delivered, the one that lets
    // the real owner stop an attack is worth more than the one that completes it.
    const user = await makeUser('changer');
    await enrol(user);
    enqueued.length = 0;

    const response = await call('POST', '/v1/me/email', {
      user,
      token: 'tok',
      body: { newEmail: `${run}-moved@test.local`, code: code() },
    });

    expect(response.statusCode).toBe(202);
    expect(enqueued.map((job) => job.name)).toEqual([
      'email-change-notice',
      'email-change-confirm',
    ]);

    const notice = enqueued[0]!.data;
    // To the OLD address, naming the new one, with a link that stops it.
    expect(notice['email']).toBe(`${run}-changer@test.local`);
    expect(notice['newEmail']).toBe(`${run}-moved@test.local`);
    expect(String(notice['cancelUrl'])).toContain(
      '/auth/email-change/cancel?token=',
    );
  }, 30_000);

  it('refuses without a valid code, and queues nothing', async () => {
    const user = await makeUser('nocode');
    await enrol(user);
    enqueued.length = 0;

    const response = await call('POST', '/v1/me/email', {
      user,
      token: 'tok',
      body: { newEmail: `${run}-nope@test.local`, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(enqueued).toHaveLength(0);
  }, 30_000);

  it('refuses an unauthenticated caller before anything else', async () => {
    const response = await call('POST', '/v1/me/email', {
      body: { newEmail: 'x@test.local', code: '123456' },
    });
    expect(response.statusCode).toBe(401);
  }, 20_000);

  it('rejects a malformed address at the contract boundary', async () => {
    const user = await makeUser('badaddr');
    await enrol(user);
    const response = await call('POST', '/v1/me/email', {
      user,
      token: 'tok',
      body: { newEmail: 'not-an-address', code: code() },
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);
});

describe('removing the second factor over HTTP', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';

  it('refuses without a code from the factor being removed', async () => {
    const user = await makeUser('keepfactor');
    await prisma.twoFactor.create({ data: { userId: user, secret: SECRET } });

    const response = await call('POST', '/v1/me/two-factor/disable', {
      user,
      token: 'tok',
      body: { code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(await prisma.twoFactor.count({ where: { userId: user } })).toBe(1);
  }, 20_000);

  it('removes it with a correct code', async () => {
    const user = await makeUser('dropfactor');
    await prisma.twoFactor.create({ data: { userId: user, secret: SECRET } });

    const response = await call('POST', '/v1/me/two-factor/disable', {
      user,
      token: 'tok',
      body: {
        code: generateAt(
          decodeBase32(SECRET)!,
          Math.floor(Date.now() / 1000 / DEFAULT_PERIOD),
        ),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await prisma.twoFactor.count({ where: { userId: user } })).toBe(0);
  }, 20_000);
});
