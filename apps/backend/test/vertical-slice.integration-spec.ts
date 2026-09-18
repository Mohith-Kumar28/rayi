import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PermissionService } from '../src/authorization/permission.service';
import type { PrismaService } from '../src/database/prisma.service';
import { AccountRole, Direction } from '../src/ledger/domain/ledger.types';
import { LedgerRepository } from '../src/ledger/infrastructure/ledger.repository';
import { AllocateBudgetProcessor } from '../src/treasury/processors/allocate-budget.processor';
import { AllocateBudgetUseCase } from '../src/treasury/use-cases/allocate-budget.use-case';

/**
 * THE VERTICAL SLICE.
 *
 * Proves the whole architecture end to end with zero Stripe and zero real money:
 *
 *   permission check → money-authority check → treasury_command written and the
 *   job enqueued in ONE transaction → worker re-derives state and re-authorises
 *   → ledger entry posted → balance moves.
 *
 * Every structural claim is exercised: the API/worker split, role separated from
 * money authority, scope taken from the resource rather than the request,
 * deterministic idempotency, and solvency enforced by the storage engine.
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

const run = randomUUID().slice(0, 8);

let orgId: string;
let workspaceId: string;
let campaignId: string;
let userId: string;
let memberId: string;
let orgLotAccount: string;

/** $10,000.00 — the organization's entire funded position for these tests. */
const FUNDED_MINOR = 1_000_000n;

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-alloc@test.local`,
      username: `${run}-alloc`,
      isEmailVerified: true,
    },
  });
  userId = user.id;

  const org = await prisma.organization.create({
    data: { name: 'Acme', slug: `acme-${run}` },
  });
  orgId = org.id;

  const workspace = await prisma.workspace.create({
    data: { organizationId: orgId, name: 'Skincare', slug: 'skincare' },
  });
  workspaceId = workspace.id;

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: orgId,
      workspaceId,
      name: 'Q4 launch',
      state: 'draft',
    },
  });
  campaignId = campaign.id;

  const member = await prisma.member.create({
    data: { organizationId: orgId, userId, role: 'member' },
  });
  memberId = member.id;

  // Campaign manager at WORKSPACE scope only. The org role grants nothing here,
  // which is the case that a naive org-only permission model gets wrong.
  await prisma.workspaceMember.create({
    data: {
      workspaceId,
      memberId,
      organizationId: orgId,
      role: 'campaign_manager',
    },
  });

  // Fund the org. In production this lot is created by the deposit lifecycle
  // from a settled ACH debit; here it is seeded through the same post_entry that
  // everything else uses, so nothing in the test bypasses the ledger.
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
    sourceId: `${run}-seed`,
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
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/** The campaign's ledger account, derived exactly as the worker derives it. */
async function campaignBalance(): Promise<bigint> {
  const account = await ledger.accountForCampaign(
    campaignId,
    AccountRole.CampaignAllocated,
    'USD',
  );
  return ledger.balanceOf(account);
}

function allocate(
  overrides: Partial<Parameters<typeof useCase.execute>[0]> = {},
) {
  return useCase.execute({
    organizationId: orgId,
    campaignId,
    amountMinor: 100_000n,
    currency: 'USD',
    idempotencyKey: `allocate:${campaignId}:${randomUUID()}`,
    actorUserId: userId,
    ...overrides,
  });
}

describe('the api refuses before any money moves', () => {
  it('refuses a campaign manager with no MoneyAuthority, though the role permits it', async () => {
    // The role grants campaign:allocate at workspace scope...
    expect(
      await permissions.can(userId, 'campaign:allocate', {
        organizationId: orgId,
        workspaceId,
      }),
    ).toBe(true);

    // ...and the request is still refused, because money authority is a separate
    // question answered by a separate row.
    await expect(allocate()).rejects.toThrow(/not authorised to move funds/i);

    // Nothing was written. The refusal happens before the command row exists, so
    // there is no pending intent for a worker to pick up later.
    expect(
      await prisma.treasuryCommand.count({ where: { organizationId: orgId } }),
    ).toBe(0);
  }, 20_000);

  it('refuses an amount above the granted limit', async () => {
    await prisma.moneyAuthority.create({
      data: {
        memberId,
        organizationId: orgId,
        capability: 'campaign:allocate',
        limitMinor: 500_000n, // $5,000.00 per transaction
        grantedBy: userId,
      },
    });

    await expect(allocate({ amountMinor: 600_000n })).rejects.toThrow(
      /exceeds your approval limit/i,
    );
  }, 20_000);

  it('refuses a zero or negative amount', async () => {
    await expect(allocate({ amountMinor: 0n })).rejects.toThrow(
      /must be positive/i,
    );
    await expect(allocate({ amountMinor: -5_000n })).rejects.toThrow(
      /must be positive/i,
    );
  }, 20_000);

  it('hides a campaign that belongs to another organization behind a 404', async () => {
    const rival = await prisma.organization.create({
      data: { name: 'Rival', slug: `rival-${run}` },
    });
    const rivalWorkspace = await prisma.workspace.create({
      data: { organizationId: rival.id, name: 'Skincare', slug: 'skincare' },
    });
    const rivalCampaign = await prisma.campaign.create({
      data: {
        organizationId: rival.id,
        workspaceId: rivalWorkspace.id,
        name: 'Theirs',
      },
    });

    // Naming our own org with their campaign: the tenant predicate is in the
    // WHERE clause, so the campaign simply does not exist for this caller.
    await expect(allocate({ campaignId: rivalCampaign.id })).rejects.toThrow(
      /no such campaign/i,
    );

    // And naming their org directly is equally invisible — the status is the
    // same either way, so the endpoint is not an existence oracle.
    await expect(
      allocate({ organizationId: rival.id, campaignId: rivalCampaign.id }),
    ).rejects.toThrow(/no such campaign/i);
  }, 20_000);

  it('refuses a currency the campaign is not denominated in', async () => {
    await expect(allocate({ currency: 'EUR' })).rejects.toThrow(
      /denominated in USD/i,
    );
  }, 20_000);
});

describe('the full path: click → command → worker → ledger', () => {
  it('allocates $2,000 from the org balance to the campaign', async () => {
    expect(await ledger.balanceOf(orgLotAccount)).toBe(FUNDED_MINOR);

    // 1. The API accepts and returns 202 — no money work inline.
    const accepted = await allocate({
      amountMinor: 200_000n,
      idempotencyKey: `allocate:${campaignId}:v1`,
      requestId: 'req-vertical-1',
    });

    expect(accepted.status).toBe('accepted');
    expect(accepted.replayed).toBe(false);

    // The command exists and is pending. No ledger movement yet, and the
    // workspace was derived from the campaign rather than supplied.
    const pending = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(pending?.status).toBe('pending');
    expect(pending?.workspaceId).toBe(workspaceId);
    expect(await campaignBalance()).toBe(0n);

    // 2. The worker picks it up and posts.
    await processor.process(accepted.commandId);

    const done = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(done?.status).toBe('completed');
    expect(done?.ledgerEntryId).toBeTruthy();

    // 3. The money moved, and both sides of the entry agree.
    expect(await ledger.balanceOf(orgLotAccount)).toBe(FUNDED_MINOR - 200_000n);
    expect(await campaignBalance()).toBe(200_000n);
  }, 30_000);

  it('is idempotent: the same key returns the original and posts nothing new', async () => {
    const key = `allocate:${campaignId}:v2`;
    const first = await allocate({ amountMinor: 50_000n, idempotencyKey: key });
    await processor.process(first.commandId);

    const balanceAfterFirst = await campaignBalance();

    // The page was refreshed, so the same deterministic key arrives again.
    const replay = await allocate({
      amountMinor: 50_000n,
      idempotencyKey: key,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(first.commandId);

    // And re-delivering the job is safe: post_entry is keyed on the command.
    await processor.process(first.commandId);
    expect(await campaignBalance()).toBe(balanceAfterFirst);

    // Exactly one ledger entry exists for that command, not two.
    const entries = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM ledger.entry
        WHERE source_type = 'treasury_command' AND source_id = $1`,
      first.commandId,
    );
    expect(entries[0]?.count).toBe(1n);
  }, 30_000);

  it('refuses to reuse an idempotency key for different terms', async () => {
    const key = `allocate:${campaignId}:v3`;
    await allocate({ amountMinor: 10_000n, idempotencyKey: key });

    // Same key, larger amount. This is not a replay — returning 202 would tell
    // the caller the new amount was accepted while the original one posts.
    await expect(
      allocate({ amountMinor: 400_000n, idempotencyKey: key }),
    ).rejects.toThrow(/already been used for a different allocation/i);
  }, 20_000);

  it('refuses to overdraw, and records WHY on the command', async () => {
    // Spend the lot down to less than one authorised transaction, using
    // ordinary allocations. The overdraft must then be reachable WITHIN the
    // actor's $5,000 limit — otherwise the API would refuse first and the test
    // would prove nothing about the database.
    const limit = 500_000n;
    for (;;) {
      const remaining = await ledger.balanceOf(orgLotAccount);
      if (remaining < limit) break;
      const accepted = await allocate({
        amountMinor: limit,
        idempotencyKey: `allocate:${campaignId}:drain:${remaining}`,
      });
      await processor.process(accepted.commandId);
    }

    const available = await ledger.balanceOf(orgLotAccount);
    expect(available).toBeLessThan(limit);
    expect(available).toBeGreaterThanOrEqual(0n);

    const accepted = await allocate({
      // Within the actor's authority, and more than the org still holds.
      amountMinor: limit,
      idempotencyKey: `allocate:${campaignId}:overdraw`,
    });

    // The API accepted it. Solvency is not its job — it cannot see the ledger,
    // and its database role has no grants on the schema at all.
    expect(accepted.status).toBe('accepted');

    // The database refuses it at the worker, as a CHECK constraint violation
    // rather than as a branch some future code path could forget to take.
    await expect(processor.process(accepted.commandId)).rejects.toThrow(
      /account_balance_non_negative/,
    );

    const failed = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.failureReason).toMatch(/account_balance_non_negative/);

    // Nothing moved.
    expect(await ledger.balanceOf(orgLotAccount)).toBe(available);

    // And a redelivery of the same job does not retry it. An overdraft is the
    // database being right, so retrying could only ever fail again — or, worse,
    // succeed later against funds meant for something else.
    await expect(
      processor.process(accepted.commandId),
    ).resolves.toBeUndefined();
    expect(await ledger.balanceOf(orgLotAccount)).toBe(available);
  }, 60_000);
});

describe('the command is a pointer, never an instruction', () => {
  it('refuses at the worker when authority was revoked after the request', async () => {
    const accepted = await allocate({
      amountMinor: 25_000n,
      idempotencyKey: `allocate:${campaignId}:revoked`,
    });
    const before = await campaignBalance();

    // The approver is stripped of money authority between the request and the
    // sweep — the exact gap a signed short-lived assertion could not close,
    // because it would still verify.
    await prisma.moneyAuthority.updateMany({
      where: { memberId, capability: 'campaign:allocate' },
      data: { revokedAt: new Date() },
    });

    await expect(processor.process(accepted.commandId)).rejects.toThrow(
      /authorization_revoked/,
    );

    const failed = await prisma.treasuryCommand.findUnique({
      where: { id: accepted.commandId },
    });
    expect(failed?.status).toBe('failed');
    expect(await campaignBalance()).toBe(before);

    // Restore for the remaining tests.
    await prisma.moneyAuthority.updateMany({
      where: { memberId, capability: 'campaign:allocate' },
      data: { revokedAt: null },
    });
  }, 30_000);

  it('refuses at the worker when the member was removed from the organization', async () => {
    const accepted = await allocate({
      amountMinor: 25_000n,
      idempotencyKey: `allocate:${campaignId}:removed`,
    });
    const before = await campaignBalance();

    const membership = await prisma.workspaceMember.findFirstOrThrow({
      where: { memberId, workspaceId },
    });
    await prisma.workspaceMember.delete({ where: { id: membership.id } });

    await expect(processor.process(accepted.commandId)).rejects.toThrow(
      /authorization_revoked/,
    );
    expect(await campaignBalance()).toBe(before);

    await prisma.workspaceMember.create({
      data: {
        workspaceId,
        memberId,
        organizationId: orgId,
        role: 'campaign_manager',
      },
    });
  }, 30_000);

  it('refuses at the worker for a command whose kind it does not own', async () => {
    // A processor that acted on any command handed to it would make the command
    // table a place to smuggle work between money paths.
    const foreign = await prisma.treasuryCommand.create({
      data: {
        kind: 'RELEASE_MILESTONE',
        idempotencyKey: `foreign:${randomUUID()}`,
        organizationId: orgId,
        workspaceId,
        campaignId,
        amountMinor: 1_000n,
        currency: 'USD',
        actorUserId: userId,
        actorMemberId: memberId,
      },
    });

    await processor.process(foreign.id);

    const after = await prisma.treasuryCommand.findUnique({
      where: { id: foreign.id },
    });
    expect(after?.status).toBe('failed');
    expect(after?.failureReason).toContain('wrong_processor');
  }, 20_000);
});

describe('a client-supplied figure is an assertion, never an instruction', () => {
  it('refuses at the worker when the balance is not what the requester saw', async () => {
    const before = await campaignBalance();
    const actual = await ledger.balanceOf(orgLotAccount);

    const accepted = await allocate({
      amountMinor: 1_000n,
      idempotencyKey: `allocate:${campaignId}:stale`,
      // The requester was looking at a figure from before someone else spent.
      expectedAvailableMinor: actual + 100_000n,
    });

    // Accepted by the API — which cannot see the ledger and so cannot know.
    expect(accepted.status).toBe('accepted');

    await processor.process(accepted.commandId);

    const failed = await prisma.treasuryCommand.findUnique({ where: { id: accepted.commandId } });
    expect(failed?.status).toBe('failed');
    expect(failed?.failureReason).toMatch(/stale_balance/);

    // Nothing was allocated, and nothing was silently adjusted to fit.
    expect(await campaignBalance()).toBe(before);
    expect(await ledger.balanceOf(orgLotAccount)).toBe(actual);
  }, 30_000);

  it('proceeds when the assertion matches', async () => {
    const before = await campaignBalance();
    const actual = await ledger.balanceOf(orgLotAccount);

    const accepted = await allocate({
      amountMinor: 1_000n,
      idempotencyKey: `allocate:${campaignId}:fresh`,
      expectedAvailableMinor: actual,
    });

    await processor.process(accepted.commandId);

    const done = await prisma.treasuryCommand.findUnique({ where: { id: accepted.commandId } });
    expect(done?.status).toBe('completed');
    expect(await campaignBalance()).toBe(before + 1_000n);
  }, 30_000);
});

describe('account derivation cannot be steered', () => {
  it('parents a campaign account to the campaign OWNER, not to the caller', async () => {
    const account = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );

    const rows = await prisma.$queryRawUnsafe<
      Array<{ org_id: string; campaign_id: string }>
    >(
      `SELECT org_id::text, campaign_id::text FROM ledger.account WHERE id = $1::uuid`,
      account,
    );

    expect(rows[0]?.org_id).toBe(orgId);
    expect(rows[0]?.campaign_id).toBe(campaignId);
  }, 20_000);

  it('returns the same account on every call rather than creating a second one', async () => {
    const a = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );
    const b = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );
    expect(a).toBe(b);
  }, 20_000);

  it('refuses to derive an account for a campaign that does not exist', async () => {
    await expect(
      ledger.accountForCampaign(
        randomUUID(),
        AccountRole.CampaignAllocated,
        'USD',
      ),
    ).rejects.toThrow();
  }, 20_000);

  it('makes a campaign account in the wrong organization unrepresentable', async () => {
    const rival = await prisma.organization.create({
      data: { name: 'Rival2', slug: `rival2-${run}` },
    });

    // Claiming our campaign belongs to the rival org: the composite foreign key
    // onto campaign(id, organizationId) rejects it at the storage engine.
    await expect(
      ledger.createAccount({
        role: AccountRole.CampaignAllocated,
        currency: 'USD',
        normalBalance: Direction.Debit,
        orgId: rival.id,
        campaignId,
      }),
    ).rejects.toThrow();
  }, 20_000);

  it('refuses a campaign-tagged account with no organization', async () => {
    const orphan = await prisma.campaign.create({
      data: { organizationId: orgId, workspaceId, name: 'Orphan test' },
    });

    // A composite FK is only checked when every column is non-null, so without
    // account_campaign_requires_org this would slip past the parentage rule.
    await expect(
      ledger.createAccount({
        role: AccountRole.CampaignAllocated,
        currency: 'USD',
        normalBalance: Direction.Debit,
        campaignId: orphan.id,
      }),
    ).rejects.toThrow();
  }, 20_000);
});

describe('the ledger still agrees with itself afterwards', () => {
  it('has balance, snapshot and sum of lines in agreement on every touched account', async () => {
    const campaignAccount = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );
    for (const account of [orgLotAccount, campaignAccount]) {
      const check = await ledger.verifyBalance(account);
      expect(check.agrees).toBe(true);
    }
  }, 20_000);

  it('has no unbalanced entry anywhere in the database', async () => {
    expect(await ledger.findUnbalancedEntries()).toEqual([]);
  }, 20_000);

  it('never allocated more than was funded', async () => {
    const campaignAccount = await ledger.accountForCampaign(
      campaignId,
      AccountRole.CampaignAllocated,
      'USD',
    );
    const lot = await ledger.balanceOf(orgLotAccount);
    const allocated = await ledger.balanceOf(campaignAccount);

    // The conservation law. Not asserted by application code anywhere — it holds
    // because every allocation is a balanced entry between exactly these two
    // accounts, and neither may go negative.
    expect(lot + allocated).toBe(FUNDED_MINOR);
    expect(lot).toBeGreaterThanOrEqual(0n);
    expect(allocated).toBeGreaterThanOrEqual(0n);
  }, 20_000);
});
