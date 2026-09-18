import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../src/audit/audit.service';
import {
  StepUpPurpose,
  StepUpService,
} from '../src/auth/step-up/step-up.service';
import {
  decodeBase32,
  DEFAULT_PERIOD,
  generateAt,
} from '../src/auth/step-up/totp';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * Step-up grants.
 *
 * The properties under test are the three that, when missing, have each been a
 * real vulnerability: a grant that is not bound to a PURPOSE, one that is not
 * bound to a RESOURCE, and one that can be spent twice.
 *
 * The resource binding is the subtle one. A grant that says only "this user
 * confirmed something" is a bearer capability — confirm a harmless action, spend
 * it on a dangerous one. That is exactly the bulk-approve hole the
 * money-integrity review found: a five-minute grant for unlimited releases.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);
const stepUp = new StepUpService(prismaService, audit);

const SECRET = 'JBSWY3DPEHPK3PXP';

function currentCode(): string {
  const key = decodeBase32(SECRET)!;
  return generateAt(key, Math.floor(Date.now() / 1000 / DEFAULT_PERIOD));
}

async function makeUser(label: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-${label}@stepup.test`,
      username: `${run}-${label}`,
      isEmailVerified: true,
      twoFactorEnabled: true,
    },
  });
  await prisma.twoFactor.create({ data: { userId: user.id, secret: SECRET } });
  return user.id;
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('minting a grant', () => {
  it('accepts a correct code', async () => {
    const userId = await makeUser('mint');
    const grant = await stepUp.mint({
      userId,
      purpose: StepUpPurpose.DisableTwoFactor,
      code: currentCode(),
    });

    expect(grant.grantId).toBeTruthy();
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Minutes, not hours. A grant that outlives the dialog is a bearer token.
    expect(grant.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      6 * 60 * 1000,
    );
  }, 20_000);

  it('rejects a wrong code, and records the failure', async () => {
    const userId = await makeUser('wrong');

    await expect(
      stepUp.mint({
        userId,
        purpose: StepUpPurpose.DisableTwoFactor,
        code: '000000',
      }),
    ).rejects.toThrow();

    const events = await prisma.$queryRawUnsafe<Array<{ action: string }>>(
      `SELECT action FROM audit.event WHERE actor_user_id = $1 ORDER BY seq DESC LIMIT 1`,
      userId,
    );
    expect(events[0]?.action).toBe('account.step_up_failed');
  }, 20_000);

  it('REFUSES when the user has no second factor, rather than waving them through', async () => {
    // "The user has not set one up yet" is exactly when an attacker would like
    // the check skipped.
    const run = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${run}-nofactor@stepup.test`,
        username: `${run}-nofactor`,
        isEmailVerified: true,
      },
    });

    await expect(
      stepUp.mint({
        userId: user.id,
        purpose: StepUpPurpose.ChangeEmail,
        code: currentCode(),
      }),
    ).rejects.toThrow(/second factor/i);
  }, 20_000);

  it('rate limits after repeated failures', async () => {
    // Six digits with a one-step window is three valid values in a million at
    // any moment. Unlimited guessing finds one in minutes at HTTP speeds, so
    // this is the difference between a second factor and a delay.
    const userId = await makeUser('bruteforce');

    for (let i = 0; i < 5; i += 1) {
      await stepUp
        .mint({ userId, purpose: StepUpPurpose.ChangeEmail, code: '000000' })
        .catch(() => undefined);
    }

    // Even the CORRECT code is now refused.
    await expect(
      stepUp.mint({
        userId,
        purpose: StepUpPurpose.ChangeEmail,
        code: currentCode(),
      }),
    ).rejects.toThrow(/too many/i);
  }, 30_000);
});

describe('a grant is bound to its purpose', () => {
  it('cannot be spent on a different purpose', async () => {
    // A grant minted to change an email must not remove a second factor.
    const userId = await makeUser('purpose');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ChangeEmail,
      code: currentCode(),
    });

    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.DisableTwoFactor }),
    ).rejects.toThrow();

    // And the right purpose still works, so the grant was genuinely minted.
    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.ChangeEmail }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('cannot be spent by a different user', async () => {
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');

    await stepUp.mint({
      userId: alice,
      purpose: StepUpPurpose.ChangeEmail,
      code: currentCode(),
    });

    await expect(
      stepUp.consume({ userId: bob, purpose: StepUpPurpose.ChangeEmail }),
    ).rejects.toThrow();
  }, 20_000);
});

describe('a grant is bound to its resource', () => {
  it('cannot be spent on a DIFFERENT resource', async () => {
    // THE hole this exists to close. Confirming "$10 to campaign A" must not
    // authorise "$10,000 to campaign B" for as long as the grant lives.
    const userId = await makeUser('resource');
    const small = StepUpService.resourceHash({
      campaign: 'A',
      amountMinor: 1000n,
    });
    const large = StepUpService.resourceHash({
      campaign: 'B',
      amountMinor: 1000000n,
    });

    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ReleaseFunds,
      code: currentCode(),
      resourceHash: small,
    });

    await expect(
      stepUp.consume({
        userId,
        purpose: StepUpPurpose.ReleaseFunds,
        resourceHash: large,
      }),
    ).rejects.toThrow();

    await expect(
      stepUp.consume({
        userId,
        purpose: StepUpPurpose.ReleaseFunds,
        resourceHash: small,
      }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('a BOUND grant cannot be spent as an unbound one', async () => {
    const userId = await makeUser('bound');
    const hash = StepUpService.resourceHash({ campaign: 'A' });

    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ReleaseFunds,
      code: currentCode(),
      resourceHash: hash,
    });

    // `null` is a real value in the WHERE clause, not a wildcard.
    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.ReleaseFunds }),
    ).rejects.toThrow();
  }, 20_000);

  it('an UNBOUND grant cannot be spent on a specific resource', async () => {
    // The dangerous direction: a cheap unbound confirmation must not satisfy an
    // action that has parameters the user was shown.
    const userId = await makeUser('unbound');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ReleaseFunds,
      code: currentCode(),
    });

    await expect(
      stepUp.consume({
        userId,
        purpose: StepUpPurpose.ReleaseFunds,
        resourceHash: StepUpService.resourceHash({ campaign: 'A' }),
      }),
    ).rejects.toThrow();
  }, 20_000);

  it('hashes independently of key order', async () => {
    // Otherwise an identical request could fail to match its own grant, for a
    // reason no user could ever diagnose.
    const a = StepUpService.resourceHash({ amountMinor: 100n, campaign: 'A' });
    const b = StepUpService.resourceHash({ campaign: 'A', amountMinor: 100n });
    expect(a).toBe(b);
  });

  it('distinguishes values that concatenate to the same string', () => {
    // `{a:'1', b:'23'}` and `{a:'12', b:'3'}` must not collide.
    expect(StepUpService.resourceHash({ a: '1', b: '23' })).not.toBe(
      StepUpService.resourceHash({ a: '12', b: '3' }),
    );
  });
});

describe('a grant is single use', () => {
  it('cannot be spent twice', async () => {
    const userId = await makeUser('single');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.RemoveMember,
      code: currentCode(),
    });

    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.RemoveMember }),
    ).resolves.toBeUndefined();
    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.RemoveMember }),
    ).rejects.toThrow();
  }, 20_000);

  it('cannot be spent twice CONCURRENTLY', async () => {
    // The check-then-spend version has a window between the two, and that window
    // is the whole vulnerability. The decrement is one conditional statement, so
    // only one racer can see `usesRemaining: 1`.
    const userId = await makeUser('race');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.RemoveMember,
      code: currentCode(),
    });

    const results = await Promise.allSettled([
      stepUp.consume({ userId, purpose: StepUpPurpose.RemoveMember }),
      stepUp.consume({ userId, purpose: StepUpPurpose.RemoveMember }),
      stepUp.consume({ userId, purpose: StepUpPurpose.RemoveMember }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  }, 20_000);

  it('cannot be spent after it expires', async () => {
    const userId = await makeUser('expired');
    const grant = await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ChangeEmail,
      code: currentCode(),
    });

    await prisma.stepUpGrant.update({
      where: { id: grant.grantId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.ChangeEmail }),
    ).rejects.toThrow();
  }, 20_000);
});

describe('has() is for rendering, never for authorization', () => {
  it('reports a live grant without spending it', async () => {
    const userId = await makeUser('peek');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ChangeEmail,
      code: currentCode(),
    });

    expect(
      await stepUp.has({ userId, purpose: StepUpPurpose.ChangeEmail }),
    ).toBe(true);
    // Still spendable — `has` must not consume, or a UI check would silently
    // burn the grant before the action ran.
    await expect(
      stepUp.consume({ userId, purpose: StepUpPurpose.ChangeEmail }),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('reports false once spent', async () => {
    const userId = await makeUser('spent');
    await stepUp.mint({
      userId,
      purpose: StepUpPurpose.ChangeEmail,
      code: currentCode(),
    });
    await stepUp.consume({ userId, purpose: StepUpPurpose.ChangeEmail });

    expect(
      await stepUp.has({ userId, purpose: StepUpPurpose.ChangeEmail }),
    ).toBe(false);
  }, 20_000);
});
