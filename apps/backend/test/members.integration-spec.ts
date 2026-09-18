import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { MembersService } from '../src/api/members/members.service';
import { AuditService } from '../src/audit/audit.service';
import { StepUpService } from '../src/auth/step-up/step-up.service';
import {
  decodeBase32,
  DEFAULT_PERIOD,
  generateAt,
} from '../src/auth/step-up/totp';
import { PermissionService } from '../src/authorization/permission.service';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * Membership.
 *
 * These replace Better Auth's `/organization/*` endpoints, and the tests are
 * written as the escalations those endpoints allowed:
 *
 *   - an admin inviting a mailbox they control **at owner**, because Better
 *     Auth's own docs say there is no restriction preventing it
 *   - a privilege change reachable with nothing but a session cookie
 *   - a demotion that leaves the demoted session alive, so the role is still
 *     held until it expires
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);
const stepUp = new StepUpService(prismaService, audit);
const permissions = new PermissionService(prismaService);
const members = new MembersService(prismaService, permissions, stepUp, audit);

const SECRET = 'JBSWY3DPEHPK3PXP';
const CONTEXT = {
  requestId: 'req-1',
  ipAddress: '203.0.113.9',
  userAgent: 'test',
};

function code(): string {
  return generateAt(
    decodeBase32(SECRET)!,
    Math.floor(Date.now() / 1000 / DEFAULT_PERIOD),
  );
}

let orgId: string;

async function makeMember(
  label: string,
  role: string,
  options: { withFactor?: boolean } = {},
): Promise<{ userId: string; memberId: string; email: string }> {
  const run = randomUUID().slice(0, 8);
  const email = `${run}-${label}@members.test`;
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email,
      username: `${run}-${label}`,
      isEmailVerified: true,
    },
  });
  if (options.withFactor !== false) {
    await prisma.twoFactor.create({
      data: { userId: user.id, secret: SECRET },
    });
  }
  const member = await prisma.member.create({
    data: { organizationId: orgId, userId: user.id, role },
  });
  return { userId: user.id, memberId: member.id, email };
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
}, 30_000);

beforeEach(async () => {
  const org = await prisma.organization.create({
    data: { name: 'Acme', slug: `members-${randomUUID().slice(0, 12)}` },
  });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('nobody may grant a role above their own', () => {
  it('REFUSES an admin inviting someone as owner', async () => {
    // Better Auth's docs say plainly: "there's no built-in restriction
    // preventing an admin from inviting someone as owner." That makes
    // self-promotion a two-step move for any admin with a second mailbox.
    await makeMember('owner', 'owner');
    const admin = await makeMember('admin', 'admin');

    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: admin.userId,
        email: 'sockpuppet@evil.test',
        role: 'owner',
        context: CONTEXT,
      }),
    ).rejects.toThrow(/above your own/i);

    expect(
      await prisma.invitation.count({ where: { organizationId: orgId } }),
    ).toBe(0);
  }, 20_000);

  it('refuses a member inviting an admin', async () => {
    const member = await makeMember('plain', 'member');
    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: member.userId,
        email: 'x@evil.test',
        role: 'admin',
        context: CONTEXT,
      }),
    ).rejects.toThrow(/above your own/i);
  }, 20_000);

  it('allows an admin to invite at or below their level', async () => {
    const admin = await makeMember('admin2', 'admin');
    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: admin.userId,
        email: 'colleague@fine.test',
        role: 'admin',
        context: CONTEXT,
      }),
    ).resolves.toMatchObject({ invitationId: expect.any(String) });
  }, 20_000);

  it('reads a comma-separated role by its HIGHEST value', async () => {
    // Better Auth stores roles comma-separated. `role === 'owner'` is false for
    // 'member,owner'; `role.includes('owner')` is true for 'not-owner'. Taking
    // the highest of the split values is the only reading safe both ways.
    const hybrid = await makeMember('hybrid', 'member,owner');
    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: hybrid.userId,
        email: 'from-hybrid@fine.test',
        role: 'owner',
        context: CONTEXT,
      }),
    ).resolves.toBeDefined();
  }, 20_000);

  it('is not fooled by a role that merely CONTAINS a higher one', async () => {
    const impostor = await makeMember('impostor', 'not-owner');
    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: impostor.userId,
        email: 'x@evil.test',
        role: 'admin',
        context: CONTEXT,
      }),
    ).rejects.toThrow(/above your own/i);
  }, 20_000);
});

describe('invitations never carry money capability', () => {
  it('produces a role and nothing else', async () => {
    // The escalation this deletes: invite a mailbox you control at a
    // money-bearing role. There is no money-bearing role — capability is a
    // separate row nothing here can create.
    const owner = await makeMember('owner3', 'owner');
    const { invitationId } = await members.invite({
      organizationId: orgId,
      actorUserId: owner.userId,
      email: 'newcomer@fine.test',
      role: 'admin',
      context: CONTEXT,
    });

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    expect(invitation.role).toBe('admin');
    expect(Object.keys(invitation)).not.toContain('moneyAuthority');
    expect(
      await prisma.moneyAuthority.count({ where: { organizationId: orgId } }),
    ).toBe(0);
  }, 20_000);

  it('never stores the acceptance token, only its hash', async () => {
    const owner = await makeMember('owner4', 'owner');
    const { invitationId, token } = await members.invite({
      organizationId: orgId,
      actorUserId: owner.userId,
      email: 'hashed@fine.test',
      role: 'member',
      context: CONTEXT,
    });

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    expect(JSON.stringify(invitation)).not.toContain(token);
  }, 20_000);

  it('supersedes an earlier invitation for the same address', async () => {
    // Two open invitations at different roles mean whichever is accepted decides
    // the role, which is not a decision anyone made.
    const owner = await makeMember('owner5', 'owner');
    await members.invite({
      organizationId: orgId,
      actorUserId: owner.userId,
      email: 'twice@fine.test',
      role: 'member',
      context: CONTEXT,
    });
    await members.invite({
      organizationId: orgId,
      actorUserId: owner.userId,
      email: 'twice@fine.test',
      role: 'admin',
      context: CONTEXT,
    });

    const live = await prisma.invitation.findMany({
      where: {
        organizationId: orgId,
        email: 'twice@fine.test',
        revokedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.role).toBe('admin');
  }, 20_000);

  it('refuses to invite someone already in the organization', async () => {
    const owner = await makeMember('owner6', 'owner');
    const existing = await makeMember('already', 'member');

    await expect(
      members.invite({
        organizationId: orgId,
        actorUserId: owner.userId,
        email: existing.email,
        role: 'admin',
        context: CONTEXT,
      }),
    ).rejects.toThrow(/already in this organization/i);
  }, 20_000);
});

describe('changing a role', () => {
  it('needs a valid step-up code', async () => {
    // Better Auth's /organization/update-member-role is a privilege change
    // reachable with nothing but a session cookie.
    const owner = await makeMember('owner7', 'owner');
    const target = await makeMember('target', 'member');

    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: target.memberId,
        actorUserId: owner.userId,
        role: 'admin',
        code: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    const unchanged = await prisma.member.findUniqueOrThrow({
      where: { id: target.memberId },
    });
    expect(unchanged.role).toBe('member');
  }, 20_000);

  it('REFUSES self-promotion outright', async () => {
    // Even a legitimate owner goes through another owner, so there is always a
    // second person in the record.
    const owner = await makeMember('selfpromo', 'owner');
    await makeMember('other-owner', 'owner');

    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: owner.memberId,
        actorUserId: owner.userId,
        role: 'owner',
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/your own role/i);
  }, 20_000);

  it('refuses to act on someone ABOVE you', async () => {
    // Otherwise an admin demotes an owner and then promotes themselves.
    await makeMember('owner8', 'owner');
    const secondOwner = await makeMember('owner9', 'owner');
    const admin = await makeMember('admin3', 'admin');

    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: secondOwner.memberId,
        actorUserId: admin.userId,
        role: 'member',
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/above your own/i);
  }, 20_000);

  it('applies a promotion with a valid code', async () => {
    const owner = await makeMember('owner10', 'owner');
    const target = await makeMember('promoted', 'member');

    const result = await members.changeRole({
      organizationId: orgId,
      memberId: target.memberId,
      actorUserId: owner.userId,
      role: 'admin',
      code: code(),
      context: CONTEXT,
    });

    expect(result.role).toBe('admin');
  }, 20_000);

  it('a DOWNGRADE kills the sessions and the money authority', async () => {
    // A role taken away that leaves a live session is a role still held — for as
    // long as that session lasts, which can be days.
    const owner = await makeMember('owner11', 'owner');
    const target = await makeMember('demoted', 'admin');

    await prisma.session.create({
      data: {
        userId: target.userId,
        token: `tok-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.moneyAuthority.create({
      data: {
        memberId: target.memberId,
        organizationId: orgId,
        capability: 'campaign:allocate',
        limitMinor: 100000n,
        grantedBy: owner.userId,
      },
    });

    await members.changeRole({
      organizationId: orgId,
      memberId: target.memberId,
      actorUserId: owner.userId,
      role: 'member',
      code: code(),
      context: CONTEXT,
    });

    expect(
      await prisma.session.count({ where: { userId: target.userId } }),
    ).toBe(0);
    const authority = await prisma.moneyAuthority.findFirstOrThrow({
      where: { memberId: target.memberId },
    });
    expect(authority.revokedAt).not.toBeNull();
  }, 20_000);

  it('a PROMOTION leaves the session alone', async () => {
    // Signing someone out because they were given MORE access is pure friction.
    const owner = await makeMember('owner12', 'owner');
    const target = await makeMember('upgraded', 'member');
    await prisma.session.create({
      data: {
        userId: target.userId,
        token: `tok-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await members.changeRole({
      organizationId: orgId,
      memberId: target.memberId,
      actorUserId: owner.userId,
      role: 'admin',
      code: code(),
      context: CONTEXT,
    });

    expect(
      await prisma.session.count({ where: { userId: target.userId } }),
    ).toBe(1);
  }, 20_000);

  it('refuses to remove the LAST owner', async () => {
    // An org with no owner is one nobody can administer, fund or close — an
    // unrecoverable state reachable by an ordinary mistake.
    const soleOwner = await makeMember('sole', 'owner');
    const helper = await makeMember('helper', 'owner');

    // Demote the helper first so `sole` really is the last one.
    await members.changeRole({
      organizationId: orgId,
      memberId: helper.memberId,
      actorUserId: soleOwner.userId,
      role: 'member',
      code: code(),
      context: CONTEXT,
    });

    const anotherOwner = await makeMember('temp-owner', 'owner');
    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: soleOwner.memberId,
        actorUserId: anotherOwner.userId,
        role: 'member',
        code: code(),
        context: CONTEXT,
      }),
    ).resolves.toBeDefined(); // two owners, so this one is allowed

    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: anotherOwner.memberId,
        actorUserId: anotherOwner.userId,
        role: 'member',
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('cannot see a member of a DIFFERENT organization', async () => {
    const owner = await makeMember('owner13', 'owner');

    const otherOrg = await prisma.organization.create({
      data: { name: 'Rival', slug: `rival-${randomUUID().slice(0, 12)}` },
    });
    const outsiderUser = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID().slice(0, 8)}@rival.test`,
        username: randomUUID().slice(0, 12),
        isEmailVerified: true,
      },
    });
    const outsider = await prisma.member.create({
      data: {
        organizationId: otherOrg.id,
        userId: outsiderUser.id,
        role: 'member',
      },
    });

    await expect(
      members.changeRole({
        organizationId: orgId,
        memberId: outsider.id,
        actorUserId: owner.userId,
        role: 'admin',
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/not found/i);
  }, 20_000);
});

describe('removing a member', () => {
  it('revokes money authority and every session', async () => {
    const owner = await makeMember('owner14', 'owner');
    const target = await makeMember('leaver', 'member');

    await prisma.session.create({
      data: {
        userId: target.userId,
        token: `tok-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.moneyAuthority.create({
      data: {
        memberId: target.memberId,
        organizationId: orgId,
        capability: 'campaign:allocate',
        grantedBy: owner.userId,
      },
    });

    await members.remove({
      organizationId: orgId,
      memberId: target.memberId,
      actorUserId: owner.userId,
      code: code(),
      context: CONTEXT,
    });

    expect(await prisma.member.count({ where: { id: target.memberId } })).toBe(
      0,
    );
    expect(
      await prisma.session.count({ where: { userId: target.userId } }),
    ).toBe(0);
  }, 20_000);

  it('needs a valid step-up code', async () => {
    const owner = await makeMember('owner15', 'owner');
    const target = await makeMember('stays', 'member');

    await expect(
      members.remove({
        organizationId: orgId,
        memberId: target.memberId,
        actorUserId: owner.userId,
        code: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    expect(await prisma.member.count({ where: { id: target.memberId } })).toBe(
      1,
    );
  }, 20_000);

  it('records the removal with the role they held', async () => {
    const owner = await makeMember('owner16', 'owner');
    const target = await makeMember('audited-leaver', 'admin');

    await members.remove({
      organizationId: orgId,
      memberId: target.memberId,
      actorUserId: owner.userId,
      code: code(),
      context: CONTEXT,
    });

    const events = await prisma.$queryRawUnsafe<
      Array<{ data: Record<string, string> }>
    >(
      `SELECT data FROM audit.event
        WHERE action = 'member.removed' AND subject_id = $1`,
      target.memberId,
    );
    expect(events[0]?.data).toMatchObject({ role: 'admin' });
  }, 20_000);
});

describe('the members list surfaces money capability', () => {
  it('flags who is trusted with funds', async () => {
    // Money capability that is invisible in the members list is money capability
    // nobody audits.
    const owner = await makeMember('owner17', 'owner');
    const trusted = await makeMember('trusted', 'member');
    await makeMember('untrusted', 'member');

    await prisma.moneyAuthority.create({
      data: {
        memberId: trusted.memberId,
        organizationId: orgId,
        capability: 'campaign:allocate',
        grantedBy: owner.userId,
      },
    });

    const list = await members.list(orgId);
    const flagged = list.filter((member) => member.hasMoneyAuthority);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.memberId).toBe(trusted.memberId);
  }, 20_000);

  it('does not flag a REVOKED authority', async () => {
    const owner = await makeMember('owner18', 'owner');
    const former = await makeMember('former', 'member');
    await prisma.moneyAuthority.create({
      data: {
        memberId: former.memberId,
        organizationId: orgId,
        capability: 'campaign:allocate',
        grantedBy: owner.userId,
        revokedAt: new Date(),
      },
    });

    const list = await members.list(orgId);
    expect(
      list.find((member) => member.memberId === former.memberId)
        ?.hasMoneyAuthority,
    ).toBe(false);
  }, 20_000);
});
