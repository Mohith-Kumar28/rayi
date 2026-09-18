import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { FundingModule } from '../src/api/funding/funding.module';
import { AuthorizationModule } from '../src/authorization/authorization.module';
import type { PrismaService } from '../src/database/prisma.service';
import { PrismaService as PrismaServiceClass } from '../src/database/prisma.service';
import { PermissionGuard } from '../src/guards/permission.guard';
import { AccountRole, Direction } from '../src/ledger/domain/ledger.types';
import { LedgerRepository } from '../src/ledger/infrastructure/ledger.repository';
import { AllocateBudgetProcessor } from '../src/treasury/processors/allocate-budget.processor';
import { AllocateBudgetUseCase } from '../src/treasury/use-cases/allocate-budget.use-case';

/**
 * The route, over real HTTP.
 *
 * The other integration specs call the use case directly, which proves the
 * logic. This one proves the WIRING: that the manifest entry actually produced a
 * reachable path, that the declared 202 is what a client receives, that the
 * deny-by-default guard is in the chain, and that contract validation rejects a
 * malformed amount before it reaches any code that could misread it.
 *
 * Authentication is stubbed — Better Auth is exercised elsewhere, and a real
 * sign-in here would test the identity provider rather than the money route.
 * Authorization is NOT stubbed: `PermissionGuard` is the real one.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const ledger = new LedgerRepository(prismaService);

/**
 * Stands in for `AuthGuard`. Reads the caller from a header instead of a
 * session cookie and attaches the same shape the real guard attaches, so
 * everything downstream is genuinely under test.
 */
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      session?: unknown;
    }>();
    const userId = request.headers['x-test-user'];
    request.session = userId ? { user: { id: userId } } : undefined;
    return true;
  }
}

@Module({
  imports: [FundingModule, AuthorizationModule],
  providers: [
    { provide: APP_GUARD, useClass: StubAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
class TestApiModule {}

let app: NestFastifyApplication;

const run = randomUUID().slice(0, 8);

let orgId: string;
let campaignId: string;
let approver: string; // permission + money authority
let manager: string; // permission, no money authority
let outsider: string; // no membership at all

async function seedUser(label: string): Promise<string> {
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

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  approver = await seedUser('approver');
  manager = await seedUser('manager');
  outsider = await seedUser('outsider');

  const org = await prisma.organization.create({
    data: { name: 'Acme', slug: `http-${run}` },
  });
  orgId = org.id;

  const workspace = await prisma.workspace.create({
    data: { organizationId: orgId, name: 'Skincare', slug: 'skincare' },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: orgId,
      workspaceId: workspace.id,
      name: 'HTTP campaign',
    },
  });
  campaignId = campaign.id;

  for (const [userId, withMoney] of [
    [approver, true],
    [manager, false],
  ] as const) {
    const member = await prisma.member.create({
      data: { organizationId: orgId, userId, role: 'member' },
    });
    await prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        memberId: member.id,
        organizationId: orgId,
        role: 'campaign_manager',
      },
    });
    if (withMoney) {
      await prisma.moneyAuthority.create({
        data: {
          memberId: member.id,
          organizationId: orgId,
          capability: 'campaign:allocate',
          limitMinor: 500_000n,
          grantedBy: userId,
        },
      });
    }
  }

  const lot = await ledger.createAccount({
    role: AccountRole.OrgLotAvailable,
    currency: 'USD',
    normalBalance: Direction.Debit,
    orgId,
  });
  const bootstrap = await ledger.createAccount({
    role: AccountRole.PlatformBootstrap,
    currency: 'USD',
    normalBalance: Direction.Credit,
    allowNegative: true,
  });
  await ledger.postEntry({
    transition: 'SEED',
    sourceType: 'test',
    sourceId: `${run}-http-seed`,
    lines: [
      { accountId: lot, direction: Direction.Debit, amountMinor: 1_000_000n },
      {
        accountId: bootstrap,
        direction: Direction.Credit,
        amountMinor: 1_000_000n,
      },
    ],
  });

  const moduleRef = await Test.createTestingModule({ imports: [TestApiModule] })
    .overrideProvider(PrismaServiceClass)
    .useValue(prismaService)
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

function post(
  userId: string | undefined,
  body: unknown,
  path = `/v1/orgs/${orgId}/campaigns/${campaignId}/allocations`,
) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/json',
      ...(userId ? { 'x-test-user': userId } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

function validBody(
  amountMinor: string,
  key = `allocate:${campaignId}:${randomUUID()}`,
) {
  return { amount: { amountMinor, currency: 'USD' }, idempotencyKey: key };
}

describe('the route exists exactly where the manifest says it does', () => {
  it('accepts an authorised allocation with 202, not 200', async () => {
    const response = await post(approver, validBody('150000'));

    // 202 comes from the manifest's successStatus. A 200 here would tell the
    // client the allocation had completed when it has only been recorded.
    expect(response.statusCode).toBe(202);

    const payload = JSON.parse(response.payload) as {
      commandId: string;
      status: string;
      campaignId: string;
    };
    expect(payload.status).toBe('accepted');
    expect(payload.campaignId).toBe(campaignId);

    const command = await prisma.treasuryCommand.findUnique({
      where: { id: payload.commandId },
    });
    expect(command?.status).toBe('pending');
    expect(command?.amountMinor).toBe(150_000n);
    // Recorded from the authenticated session, never from the request body.
    expect(command?.actorUserId).toBe(approver);
  }, 30_000);

  it('returns the same command for a replayed idempotency key', async () => {
    const body = validBody('25000', `allocate:${campaignId}:http-replay`);

    const first = JSON.parse((await post(approver, body)).payload) as {
      commandId: string;
    };
    const second = JSON.parse((await post(approver, body)).payload) as {
      commandId: string;
    };

    expect(second.commandId).toBe(first.commandId);
    expect(
      await prisma.treasuryCommand.count({
        where: { idempotencyKey: `allocate:${campaignId}:http-replay` },
      }),
    ).toBe(1);
  }, 30_000);

  it('404s an unknown path rather than falling through to a catch-all', async () => {
    const response = await post(
      approver,
      validBody('1000'),
      `/v1/orgs/${orgId}/allocations`,
    );
    expect(response.statusCode).toBe(404);
  }, 20_000);
});

describe('the guard is in the chain and denies by default', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const response = await post(undefined, validBody('1000'));
    expect(response.statusCode).toBe(401);
  }, 20_000);

  it('gives a non-member 404, never 403 — the endpoint is not an existence oracle', async () => {
    const response = await post(outsider, validBody('1000'));
    expect(response.statusCode).toBe(404);
  }, 20_000);

  it('rejects a member with the permission but no money authority at the GUARD', async () => {
    const response = await post(manager, validBody('1000'));
    expect(response.statusCode).toBe(403);
    expect(response.payload).toMatch(/not authorised to move funds/i);

    // The guard refused before the handler ran, so no command row exists.
    expect(
      await prisma.treasuryCommand.count({
        where: { organizationId: orgId, actorUserId: manager },
      }),
    ).toBe(0);
  }, 20_000);

  it('rejects an amount above the approver limit at the HANDLER', async () => {
    // The guard cannot see the amount; only the handler can. Both checks are
    // needed and neither is sufficient.
    const response = await post(approver, validBody('600000'));
    expect(response.statusCode).toBe(403);
    expect(response.payload).toMatch(/exceeds your approval limit/i);
  }, 20_000);
});

describe('contract validation rejects malformed money before it can be misread', () => {
  it.each([
    ['a decimal string', '150.00'],
    ['an empty string', ''],
    ['exponential notation', '1e5'],
    ['a leading zero', '007'],
  ])(
    'rejects %s with 400',
    async (_label, amountMinor) => {
      const response = await post(approver, validBody(amountMinor));
      expect(response.statusCode).toBe(400);
    },
    20_000,
  );

  it('rejects a JSON number, which is the shape that loses precision', async () => {
    const response = await post(approver, {
      amount: { amountMinor: 150000, currency: 'USD' },
      idempotencyKey: `allocate:${campaignId}:${randomUUID()}`,
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);

  it('rejects an unsupported currency', async () => {
    const response = await post(approver, {
      amount: { amountMinor: '1000', currency: 'XYZ' },
      idempotencyKey: `allocate:${campaignId}:${randomUUID()}`,
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);

  it('rejects a too-short idempotency key rather than accepting a guessable one', async () => {
    const response = await post(approver, {
      amount: { amountMinor: '1000', currency: 'USD' },
      idempotencyKey: 'short',
    });
    expect(response.statusCode).toBe(400);
  }, 20_000);

  it('rejects a non-uuid campaign id at the path, before any database lookup', async () => {
    const response = await post(
      approver,
      validBody('1000'),
      `/v1/orgs/${orgId}/campaigns/not-a-uuid/allocations`,
    );
    expect(response.statusCode).toBe(400);
  }, 20_000);
});

describe('the api graph cannot reach the money path', () => {
  /**
   * The DI half of the boundary. dependency-cruiser polices the import graph;
   * this polices the injector, which is the thing that actually decides what a
   * request handler can lay hands on.
   *
   * Both checks are needed. A provider can be importable and unbound (harmless),
   * or bound without being imported by a controller (still reachable through
   * `moduleRef.get`). Only asserting both makes the claim true.
   */
  it('has no AllocateBudgetProcessor bound anywhere in it', () => {
    expect(() => app.get(AllocateBudgetProcessor, { strict: false })).toThrow();
  });

  it('has no LedgerRepository bound anywhere in it', () => {
    expect(() => app.get(LedgerRepository, { strict: false })).toThrow();
  });

  it('does have the use case, which is the only intended way in', () => {
    expect(app.get(AllocateBudgetUseCase, { strict: false })).toBeInstanceOf(
      AllocateBudgetUseCase,
    );
  });
});
