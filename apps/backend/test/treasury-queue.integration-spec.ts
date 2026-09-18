import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PermissionService } from '../src/authorization/permission.service';
import type { PrismaService } from '../src/database/prisma.service';
import { AccountRole, Direction } from '../src/ledger/domain/ledger.types';
import { LedgerRepository } from '../src/ledger/infrastructure/ledger.repository';
import { AllocateBudgetProcessor } from '../src/treasury/processors/allocate-budget.processor';
import { TreasuryCommandListener } from '../src/treasury/treasury-command.listener';
import { AllocateBudgetUseCase } from '../src/treasury/use-cases/allocate-budget.use-case';

/**
 * The queue, end to end, with nobody calling the processor by hand.
 *
 * This is the roadmap's completion criterion for the vertical slice taken
 * literally: a request arrives, a row is written, and a balance changes —
 * with the worker discovering the work for itself.
 *
 * Two mechanisms are tested separately on purpose, because only one of them is
 * load-bearing:
 *
 *   NOTIFY  is latency. Fire-and-forget, dropped if nobody is listening.
 *   POLLING is correctness. The row is the queue, and rows survive everything.
 *
 * The second test deliberately writes a command while no listener is running,
 * which is what a deploy, a crash or a failover looks like. A design that
 * depended on the notification would lose that allocation silently.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;

const permissions = new PermissionService(prismaService);
const ledger = new LedgerRepository(prismaService);
const useCase = new AllocateBudgetUseCase(prismaService, permissions);
const processor = new AllocateBudgetProcessor(
  prismaService,
  ledger,
  permissions,
);

const config = {
  get: (key: string) => (key === 'database.url' ? DATABASE_URL : undefined),
};

const run = randomUUID().slice(0, 8);

let orgId: string;
let campaignId: string;
let userId: string;
let orgLotAccount: string;
let listener: TreasuryCommandListener | undefined;

const FUNDED_MINOR = 500_000n;

async function campaignBalance(): Promise<bigint> {
  const account = await ledger.accountForCampaign(
    campaignId,
    AccountRole.CampaignAllocated,
    'USD',
  );
  return ledger.balanceOf(account);
}

/** Waits for a condition rather than sleeping a fixed interval. */
async function until(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function startListener(): TreasuryCommandListener {
  return new TreasuryCommandListener(
    prismaService,
    config as unknown as ConfigService,
    processor,
  );
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-queue@test.local`,
      username: `${run}-queue`,
      isEmailVerified: true,
    },
  });
  userId = user.id;

  const org = await prisma.organization.create({
    data: { name: 'Acme', slug: `queue-${run}` },
  });
  orgId = org.id;

  const workspace = await prisma.workspace.create({
    data: { organizationId: orgId, name: 'Skincare', slug: 'skincare' },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: orgId,
      workspaceId: workspace.id,
      name: 'Queue campaign',
    },
  });
  campaignId = campaign.id;

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
  await prisma.moneyAuthority.create({
    data: {
      memberId: member.id,
      organizationId: orgId,
      capability: 'campaign:allocate',
      limitMinor: 100_000n,
      grantedBy: userId,
    },
  });

  orgLotAccount = await ledger.createAccount({
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
    sourceId: `${run}-queue-seed`,
    lines: [
      {
        accountId: orgLotAccount,
        direction: Direction.Debit,
        amountMinor: FUNDED_MINOR,
      },
      {
        accountId: bootstrap,
        direction: Direction.Credit,
        amountMinor: FUNDED_MINOR,
      },
    ],
  });
}, 60_000);

afterEach(async () => {
  await listener?.onApplicationShutdown();
  listener = undefined;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a request becomes a balance change with nobody driving the worker', () => {
  it('picks the command up from the notification and posts it', async () => {
    listener = startListener();
    await listener.onModuleInit();

    const accepted = await useCase.execute({
      organizationId: orgId,
      campaignId,
      amountMinor: 30_000n,
      currency: 'USD',
      idempotencyKey: `allocate:${campaignId}:notify`,
      actorUserId: userId,
    });

    await until(
      async () => (await campaignBalance()) === 30_000n,
      5_000,
      'the notified allocation to land in the ledger',
    );

    const command = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(command?.status).toBe('completed');
    expect(await ledger.balanceOf(orgLotAccount)).toBe(FUNDED_MINOR - 30_000n);
  }, 30_000);

  it('recovers a command written while no worker was listening', async () => {
    // Nothing is running. The notification this raises reaches nobody and is
    // gone — which is exactly what happens during a deploy.
    const accepted = await useCase.execute({
      organizationId: orgId,
      campaignId,
      amountMinor: 20_000n,
      currency: 'USD',
      idempotencyKey: `allocate:${campaignId}:missed-notify`,
      actorUserId: userId,
    });

    const missed = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(missed?.status).toBe('pending');

    // A worker starts. The row is still there, so the work is still there.
    listener = startListener();
    await listener.onModuleInit();

    await until(
      async () => (await campaignBalance()) === 50_000n,
      10_000,
      'the missed allocation to be swept up',
    );

    const recovered = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(recovered?.status).toBe('completed');
  }, 30_000);

  it('does not double-post when two workers race the same command', async () => {
    const before = await campaignBalance();

    const accepted = await useCase.execute({
      organizationId: orgId,
      campaignId,
      amountMinor: 10_000n,
      currency: 'USD',
      idempotencyKey: `allocate:${campaignId}:race`,
      actorUserId: userId,
    });

    // Both "workers" are handed the same command at the same moment. The ledger
    // is the arbiter: post_entry is keyed on the command id, so the second call
    // returns the first entry rather than posting a new one.
    await Promise.all([
      processor.process(accepted.commandId),
      processor.process(accepted.commandId),
    ]);

    expect(await campaignBalance()).toBe(before + 10_000n);

    const entries = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ledger.entry
        WHERE source_type = 'treasury_command' AND source_id = $1`,
      accepted.commandId,
    );
    expect(entries[0]?.count).toBe(1n);
  }, 30_000);

  it('leaves the ledger internally consistent throughout', async () => {
    const campaignAccount = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );
    for (const account of [orgLotAccount, campaignAccount]) {
      expect((await ledger.verifyBalance(account)).agrees).toBe(true);
    }
    const lot = await ledger.balanceOf(orgLotAccount);
    const allocated = await ledger.balanceOf(campaignAccount);
    expect(lot + allocated).toBe(FUNDED_MINOR);
  }, 20_000);
});
