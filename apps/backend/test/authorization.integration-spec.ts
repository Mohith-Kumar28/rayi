import { PrismaClient } from '@prisma/client';

import { PermissionService } from '../src/authorization/permission.service';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * Authorization against a real database.
 *
 * The properties under test are relational — composite foreign keys, the union
 * of org and workspace roles, the separation of role from money authority. A
 * mocked Prisma would assert only that the mock returns what it was told to.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const permissions = new PermissionService(prisma as unknown as PrismaService);

const run = Math.random().toString(36).slice(2, 8);

let orgA: string;
let orgB: string;
let workspaceA: string;
let workspaceB: string;
let alice: string; // campaign manager in workspace A, no money authority
let bob: string; // org owner of A
let mallory: string; // member of org B only
let aliceMemberId: string;

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  const mkUser = async (name: string) => {
    const user = await prisma.user.create({
      data: {
        id: `${run}-${name}`,
        email: `${run}-${name}@test.local`,
        username: `${run}-${name}`,
        isEmailVerified: true,
      },
    });
    return user.id;
  };

  alice = await mkUser('alice');
  bob = await mkUser('bob');
  mallory = await mkUser('mallory');

  const a = await prisma.organization.create({
    data: { name: 'Acme', slug: `acme-${run}` },
  });
  const b = await prisma.organization.create({
    data: { name: 'Rival', slug: `rival-${run}` },
  });
  orgA = a.id;
  orgB = b.id;

  const wa = await prisma.workspace.create({
    data: { organizationId: orgA, name: 'Skincare', slug: 'skincare' },
  });
  const wb = await prisma.workspace.create({
    data: { organizationId: orgB, name: 'Skincare', slug: 'skincare' }, // same slug, different org
  });
  workspaceA = wa.id;
  workspaceB = wb.id;

  const aliceMember = await prisma.member.create({
    data: { organizationId: orgA, userId: alice, role: 'member' },
  });
  aliceMemberId = aliceMember.id;

  await prisma.member.create({
    data: { organizationId: orgA, userId: bob, role: 'owner' },
  });
  await prisma.member.create({
    data: { organizationId: orgB, userId: mallory, role: 'owner' },
  });

  await prisma.workspaceMember.create({
    data: {
      workspaceId: workspaceA,
      memberId: aliceMemberId,
      organizationId: orgA,
      role: 'campaign_manager',
    },
  });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('effective permissions are the union of org and workspace roles', () => {
  it('gives a plain org member almost nothing at org scope', async () => {
    const perms = await permissions.effectivePermissions(alice, {
      organizationId: orgA,
    });
    expect(perms.has('org:read')).toBe(true);
    expect(perms.has('campaign:allocate')).toBe(false);
  });

  it('adds workspace permissions when a workspace is named', async () => {
    const perms = await permissions.effectivePermissions(alice, {
      organizationId: orgA,
      workspaceId: workspaceA,
    });
    // From the workspace role, not the org role.
    expect(perms.has('campaign:allocate')).toBe(true);
    expect(perms.has('deliverable:review')).toBe(true);
  });

  it('gives the owner org-wide capability without any workspace role', async () => {
    const perms = await permissions.effectivePermissions(bob, {
      organizationId: orgA,
    });
    expect(perms.has('funds:deposit')).toBe(true);
    expect(perms.has('member:invite')).toBe(true);
  });
});

describe('cross-tenant isolation', () => {
  it('returns NOTHING for a user asking about an org they do not belong to', async () => {
    const perms = await permissions.effectivePermissions(mallory, {
      organizationId: orgA,
    });
    expect(perms.size).toBe(0);
  });

  it('does not leak a workspace role across orgs, even with an identical slug', async () => {
    // workspaceB has the same slug as workspaceA but belongs to org B. Naming
    // org A with org B's workspace id must yield nothing.
    const perms = await permissions.effectivePermissions(alice, {
      organizationId: orgA,
      workspaceId: workspaceB,
    });
    expect(perms.has('campaign:allocate')).toBe(false);
  });

  /**
   * The composite FK is the real control. Without it, the two independent
   * foreign keys would each be individually satisfiable while pairing a member of
   * org A with a workspace in org B — and workspace slugs are unique per-org, not
   * globally, so the ids genuinely collide in practice.
   */
  it('makes a cross-org workspace membership UNREPRESENTABLE at the database level', async () => {
    await expect(
      prisma.workspaceMember.create({
        data: {
          workspaceId: workspaceB, // org B
          memberId: aliceMemberId, // org A
          organizationId: orgA,
          role: 'workspace_admin',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('money authority is never granted by a role', () => {
  it('denies a campaign manager who has campaign:allocate but no MoneyAuthority row', async () => {
    const perms = await permissions.effectivePermissions(alice, {
      organizationId: orgA,
      workspaceId: workspaceA,
    });
    expect(perms.has('campaign:allocate')).toBe(true); // the role permits asking

    const authority = await permissions.hasMoneyAuthority(
      alice,
      'campaign:allocate',
      {
        organizationId: orgA,
      },
    );
    expect(authority.granted).toBe(false); // but money does not move
    expect(authority.reason).toBe('no_money_authority');
  });

  it('denies even the org OWNER without an explicit grant', async () => {
    const authority = await permissions.hasMoneyAuthority(
      bob,
      'campaign:allocate',
      {
        organizationId: orgA,
      },
    );
    expect(authority.granted).toBe(false);
  });

  it('grants once a MoneyAuthority row exists', async () => {
    await prisma.moneyAuthority.create({
      data: {
        memberId: aliceMemberId,
        organizationId: orgA,
        capability: 'campaign:allocate',
        limitMinor: 500_000n, // $5,000.00
        grantedBy: bob,
      },
    });

    const authority = await permissions.hasMoneyAuthority(
      alice,
      'campaign:allocate',
      {
        organizationId: orgA,
      },
    );
    expect(authority.granted).toBe(true);
    expect(authority.limitMinor).toBe(500_000n);
  });

  it('enforces the per-transaction limit', async () => {
    const within = await permissions.hasMoneyAuthority(
      alice,
      'campaign:allocate',
      { organizationId: orgA },
      499_999n,
    );
    expect(within.granted).toBe(true);

    const over = await permissions.hasMoneyAuthority(
      alice,
      'campaign:allocate',
      { organizationId: orgA },
      500_001n,
    );
    expect(over.granted).toBe(false);
    expect(over.reason).toBe('exceeds_limit');
  });

  it('revokes cleanly', async () => {
    await prisma.moneyAuthority.updateMany({
      where: { memberId: aliceMemberId, capability: 'campaign:allocate' },
      data: { revokedAt: new Date() },
    });

    const authority = await permissions.hasMoneyAuthority(
      alice,
      'campaign:allocate',
      {
        organizationId: orgA,
      },
    );
    expect(authority.granted).toBe(false);
  });
});

describe('comma-separated roles cannot smuggle capability', () => {
  /**
   * Better Auth stores roles comma-separated and enforces no ceiling on
   * invitations. A naive `role === 'owner'` check is false for 'member,owner',
   * but a naive `role.includes('owner')` is true for 'not-owner'. Splitting is
   * the only safe read — and money capability does not come from roles anyway.
   */
  it('reads every role in a comma-separated value', async () => {
    const user = await prisma.user.create({
      data: {
        id: `${run}-carol`,
        email: `${run}-carol@test.local`,
        username: `${run}-carol`,
        isEmailVerified: true,
      },
    });
    await prisma.member.create({
      data: { organizationId: orgA, userId: user.id, role: 'member,admin' },
    });

    const perms = await permissions.effectivePermissions(user.id, {
      organizationId: orgA,
    });
    // Both roles contribute.
    expect(perms.has('org:read')).toBe(true); // member
    expect(perms.has('member:invite')).toBe(true); // admin

    // But still no money.
    const authority = await permissions.hasMoneyAuthority(
      user.id,
      'funds:deposit',
      {
        organizationId: orgA,
      },
    );
    expect(authority.granted).toBe(false);
  });
});
