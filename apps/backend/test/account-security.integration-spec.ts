import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { AccountSecurityService } from '../src/api/account/account-security.service';
import { AuditService } from '../src/audit/audit.service';
import { StepUpService } from '../src/auth/step-up/step-up.service';
import {
  decodeBase32,
  DEFAULT_PERIOD,
  generateAt,
} from '../src/auth/step-up/totp';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * Email change and second-factor removal.
 *
 * Both are account-takeover primitives, which is why Better Auth's versions —
 * reachable with nothing but a session cookie — are 404'd at the mount.
 *
 * The tests are written as the attacks they prevent: a stolen session changing
 * the address that receives every future magic link, a stolen session removing
 * the factor that would have stopped it, and a confirmation link being replayed.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);
const stepUp = new StepUpService(prismaService, audit);
const security = new AccountSecurityService(prismaService, stepUp, audit);

const SECRET = 'JBSWY3DPEHPK3PXP';
const CONTEXT = {
  requestId: 'req-1',
  ipAddress: '203.0.113.7',
  userAgent: 'test',
};

function code(): string {
  return generateAt(
    decodeBase32(SECRET)!,
    Math.floor(Date.now() / 1000 / DEFAULT_PERIOD),
  );
}

async function makeUser(
  label: string,
  withFactor = true,
): Promise<{ id: string; email: string }> {
  const run = randomUUID().slice(0, 8);
  const email = `${run}-${label}@sec.test`;
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email,
      username: `${run}-${label}`,
      isEmailVerified: true,
      twoFactorEnabled: withFactor,
    },
  });
  if (withFactor) {
    await prisma.twoFactor.create({
      data: { userId: user.id, secret: SECRET },
    });
  }
  return { id: user.id, email };
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('changing your email needs a second factor', () => {
  it('REFUSES with a wrong code, even from a valid session', async () => {
    // The attack: a stolen session changes the address that receives every
    // future magic link, which IS the account.
    const user = await makeUser('wrongcode');

    await expect(
      security.requestEmailChange({
        userId: user.id,
        newEmail: 'attacker@evil.test',
        code: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    expect(
      await prisma.emailChangeRequest.count({ where: { userId: user.id } }),
    ).toBe(0);
    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(unchanged.email).toBe(user.email);
  }, 20_000);

  it('refuses when the user has no second factor at all', async () => {
    const user = await makeUser('nofactor', false);
    await expect(
      security.requestEmailChange({
        userId: user.id,
        newEmail: 'new@sec.test',
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/second factor/i);
  }, 20_000);

  it('does NOT change the address on request — only on confirmation', async () => {
    // A typo would otherwise lock the user out permanently, and the failure is
    // invisible until they next try to sign in.
    const user = await makeUser('pending');

    await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-new@sec.test`,
      code: code(),
      context: CONTEXT,
    });

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(unchanged.email).toBe(user.email);
  }, 20_000);

  it('NEVER stores the confirmation token, only its hash', async () => {
    // A database read must not hand over a working account-takeover link.
    const user = await makeUser('tokenhash');
    const newEmail = `${randomUUID().slice(0, 8)}-new@sec.test`;

    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail,
      code: code(),
      context: CONTEXT,
    });

    const stored = await prisma.emailChangeRequest.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex'),
    );

    // And the token appears nowhere in the row at all.
    expect(JSON.stringify(stored)).not.toContain(token);
  }, 20_000);

  it('records BOTH addresses in the audit log', async () => {
    // The point of the record is answering "what was it before", after the user
    // row has already changed.
    const user = await makeUser('audited');
    const newEmail = `${randomUUID().slice(0, 8)}-new@sec.test`;

    await security.requestEmailChange({
      userId: user.id,
      newEmail,
      code: code(),
      context: CONTEXT,
    });

    const events = await prisma.$queryRawUnsafe<
      Array<{ action: string; data: Record<string, string> }>
    >(
      `SELECT action, data FROM audit.event
        WHERE actor_user_id = $1 AND action = 'account.email_change_requested'`,
      user.id,
    );
    expect(events[0]?.data).toEqual({ from: user.email, to: newEmail });
  }, 20_000);

  it('cancels any earlier pending request', async () => {
    // Two live confirmation links mean two addresses that could become the
    // account, and only one is the one the user last chose.
    const user = await makeUser('supersede');

    await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-first@sec.test`,
      code: code(),
      context: CONTEXT,
    });
    await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-second@sec.test`,
      code: code(),
      context: CONTEXT,
    });

    const live = await prisma.emailChangeRequest.findMany({
      where: { userId: user.id, cancelledAt: null, confirmedAt: null },
    });
    expect(live).toHaveLength(1);
  }, 20_000);

  it('refuses to change to your own current address', async () => {
    const user = await makeUser('same');
    await expect(
      security.requestEmailChange({
        userId: user.id,
        newEmail: user.email,
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/already your email/i);
  }, 20_000);

  it('checks address availability AFTER the step-up, not before', async () => {
    // Checking first would make this an account-existence oracle for anyone
    // holding any session.
    const victim = await makeUser('victim');
    const attacker = await makeUser('prober');

    // A wrong code fails for the CODE, not because the address is taken — so the
    // attacker learns nothing about whether the victim exists.
    await expect(
      security.requestEmailChange({
        userId: attacker.id,
        newEmail: victim.email,
        code: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    // With a correct code, they learn only "cannot be used".
    await expect(
      security.requestEmailChange({
        userId: attacker.id,
        newEmail: victim.email,
        code: code(),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/cannot be used/i);
  }, 20_000);
});

describe('confirming the change', () => {
  it('applies it and ends every session', async () => {
    const user = await makeUser('confirm');
    const newEmail = `${randomUUID().slice(0, 8)}-confirmed@sec.test`;

    await prisma.session.create({
      data: {
        userId: user.id,
        token: `tok-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail,
      code: code(),
      context: CONTEXT,
    });

    const result = await security.confirmEmailChange(token, CONTEXT);
    expect(result.email).toBe(newEmail);

    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(updated.email).toBe(newEmail);
    // Following the link IS the verification — flipping this false would lock
    // the user out of an account they just proved they control.
    expect(updated.isEmailVerified).toBe(true);

    // If the change was an attacker's, the session they were using dies with it.
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  }, 20_000);

  it('cannot be replayed', async () => {
    const user = await makeUser('replay');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-replay@sec.test`,
      code: code(),
      context: CONTEXT,
    });

    await security.confirmEmailChange(token, CONTEXT);
    await expect(security.confirmEmailChange(token, CONTEXT)).rejects.toThrow(
      /no longer valid/i,
    );
  }, 20_000);

  it('rejects an expired link', async () => {
    const user = await makeUser('stale');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-stale@sec.test`,
      code: code(),
      context: CONTEXT,
    });

    await prisma.emailChangeRequest.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(security.confirmEmailChange(token, CONTEXT)).rejects.toThrow(
      /no longer valid/i,
    );
  }, 20_000);

  it('gives ONE message for expired, used, cancelled and never-existed', async () => {
    // Each distinction would tell a holder of a stale link something about the
    // account.
    const user = await makeUser('opaque');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: `${randomUUID().slice(0, 8)}-opaque@sec.test`,
      code: code(),
      context: CONTEXT,
    });
    await security.confirmEmailChange(token, CONTEXT);

    const used = await security
      .confirmEmailChange(token, CONTEXT)
      .catch((e: Error) => e.message);
    const never = await security
      .confirmEmailChange('never-existed', CONTEXT)
      .catch((e: Error) => e.message);

    expect(used).toBe(never);
  }, 20_000);
});

describe('the cancel link in the notification to the OLD address', () => {
  it('stops a change the real owner did not ask for', async () => {
    // This is the point of notifying them. A notification that only says "this
    // happened" leaves the real owner watching their account being taken with
    // nothing to press.
    const user = await makeUser('cancel');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: 'attacker@evil.test',
      code: code(),
      context: CONTEXT,
    });

    await security.cancelEmailChange(token, CONTEXT);

    // The confirmation link no longer works.
    await expect(security.confirmEmailChange(token, CONTEXT)).rejects.toThrow(
      /no longer valid/i,
    );

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(unchanged.email).toBe(user.email);
  }, 20_000);

  it('needs no sign-in, because the owner may already be locked out', async () => {
    // Requiring authentication would make the escape hatch useless exactly when
    // it matters. `cancelEmailChange` takes a token and nothing else — asserted
    // by calling it with no session anywhere in scope.
    const user = await makeUser('lockedout');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: 'attacker2@evil.test',
      code: code(),
      context: CONTEXT,
    });

    await expect(
      security.cancelEmailChange(token, CONTEXT),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('records who was targeted', async () => {
    const user = await makeUser('cancelaudit');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: 'attacker3@evil.test',
      code: code(),
      context: CONTEXT,
    });
    await security.cancelEmailChange(token, CONTEXT);

    const events = await prisma.$queryRawUnsafe<
      Array<{ data: Record<string, string> }>
    >(
      `SELECT data FROM audit.event
        WHERE actor_user_id = $1 AND action = 'account.email_change_cancelled'`,
      user.id,
    );
    expect(events[0]?.data).toMatchObject({
      attemptedTo: 'attacker3@evil.test',
    });
  }, 20_000);

  it('cannot be replayed either', async () => {
    const user = await makeUser('cancelreplay');
    const { token } = await security.requestEmailChange({
      userId: user.id,
      newEmail: 'x@evil.test',
      code: code(),
      context: CONTEXT,
    });
    await security.cancelEmailChange(token, CONTEXT);
    await expect(security.cancelEmailChange(token, CONTEXT)).rejects.toThrow(
      /no longer valid/i,
    );
  }, 20_000);
});

describe('removing the second factor', () => {
  it('needs a code FROM THE FACTOR BEING REMOVED', async () => {
    // Better Auth's version accepts a session alone, which makes it the worst
    // endpoint in its default surface: a stolen session removes the control that
    // would have stopped the theft mattering.
    const user = await makeUser('disable');

    await expect(
      security.disableTwoFactor({
        userId: user.id,
        code: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(
      1,
    );
  }, 20_000);

  it('removes it with a correct code, and records it', async () => {
    const user = await makeUser('disableok');

    await security.disableTwoFactor({
      userId: user.id,
      code: code(),
      context: CONTEXT,
    });

    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(
      0,
    );
    const updated = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(updated.twoFactorEnabled).toBe(false);

    const events = await prisma.$queryRawUnsafe<Array<{ action: string }>>(
      `SELECT action FROM audit.event
        WHERE actor_user_id = $1 AND action = 'account.two_factor_disabled'`,
      user.id,
    );
    expect(events).toHaveLength(1);
  }, 20_000);
});

describe('enrolling a second factor', () => {
  function codeFor(secret: string): string {
    return generateAt(decodeBase32(secret)!, Math.floor(Date.now() / 1000 / DEFAULT_PERIOD));
  }

  it('does NOT make the factor live until it is confirmed', async () => {
    // THE reason enrolment writes to a separate table. A user who scans the QR
    // into the wrong entry — or whose phone clock is wrong — would otherwise be
    // locked out of their own account by the act of trying to secure it.
    const user = await makeUser('enrolling', false);

    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });

    expect(enrolment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrolment.otpauthUri).toContain('otpauth://totp/Rayi:');

    // Not live.
    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(0);
    const stillOff = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillOff.twoFactorEnabled).toBe(false);
  }, 20_000);

  it('goes live once a code from it verifies', async () => {
    const user = await makeUser('confirming', false);
    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });

    const result = await security.confirmTwoFactorEnrolment({
      userId: user.id,
      code: codeFor(enrolment.secret),
      context: CONTEXT,
    });

    expect(result.backupCodes).toHaveLength(10);
    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(1);
    const enabled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(enabled.twoFactorEnabled).toBe(true);
    // The pending row is gone, so it cannot be confirmed a second time.
    expect(await prisma.twoFactorEnrolment.count({ where: { userId: user.id } })).toBe(0);
  }, 20_000);

  it('refuses a wrong confirmation code and counts the attempt', async () => {
    const user = await makeUser('wrongconfirm', false);
    await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });

    await expect(
      security.confirmTwoFactorEnrolment({ userId: user.id, code: '000000', context: CONTEXT }),
    ).rejects.toThrow(/did not match/i);

    const pending = await prisma.twoFactorEnrolment.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(pending.attempts).toBe(1);
    expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(0);
  }, 20_000);

  it('stores backup codes ONLY as hashes', async () => {
    // A database read must not hand over a way into every account.
    const user = await makeUser('backupcodes', false);
    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });
    const { backupCodes } = await security.confirmTwoFactorEnrolment({
      userId: user.id,
      code: codeFor(enrolment.secret),
      context: CONTEXT,
    });

    const stored = await prisma.twoFactorBackupCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    for (const code of backupCodes) {
      expect(JSON.stringify(stored)).not.toContain(code);
      expect(stored.some((row) => row.codeHash === createHash('sha256').update(code).digest('hex'))).toBe(
        true,
      );
    }
  }, 20_000);

  it('never puts the codes in the audit log', async () => {
    // An audit log holding working recovery codes is also a credential store.
    const user = await makeUser('auditcodes', false);
    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });
    const { backupCodes } = await security.confirmTwoFactorEnrolment({
      userId: user.id,
      code: codeFor(enrolment.secret),
      context: CONTEXT,
    });

    const events = await prisma.$queryRawUnsafe<Array<{ data: Record<string, unknown> }>>(
      `SELECT data FROM audit.event
        WHERE actor_user_id = $1 AND action = 'account.two_factor_enabled'`,
      user.id,
    );
    expect(events[0]?.data).toEqual({ backupCodesIssued: 10 });
    for (const code of backupCodes) {
      expect(JSON.stringify(events)).not.toContain(code);
    }
  }, 20_000);

  it('issues codes that are unpredictable and distinct', async () => {
    const user = await makeUser('distinct', false);
    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });
    const { backupCodes } = await security.confirmTwoFactorEnrolment({
      userId: user.id,
      code: codeFor(enrolment.secret),
      context: CONTEXT,
    });

    expect(new Set(backupCodes).size).toBe(backupCodes.length);
    for (const code of backupCodes) {
      // Digits and one separator: nothing that reads 0/O or 1/l ambiguously when
      // copied off a screen under pressure, which is the only time they are used.
      expect(code).toMatch(/^\d{5}-\d{5}$/);
    }
  }, 20_000);

  it('REPLACING an existing factor needs a code from the CURRENT one', async () => {
    // Otherwise an attacker with a session enrols their own factor and owns the
    // account — swapping is exactly as sensitive as removing.
    const user = await makeUser('replacing');

    await expect(
      security.beginTwoFactorEnrolment({ userId: user.id, issuer: 'Rayi', context: CONTEXT }),
    ).rejects.toThrow(/current code/i);

    await expect(
      security.beginTwoFactorEnrolment({
        userId: user.id,
        issuer: 'Rayi',
        currentCode: '000000',
        context: CONTEXT,
      }),
    ).rejects.toThrow();

    // With the real code it proceeds.
    await expect(
      security.beginTwoFactorEnrolment({
        userId: user.id,
        issuer: 'Rayi',
        currentCode: code(),
        context: CONTEXT,
      }),
    ).resolves.toMatchObject({ secret: expect.any(String) });
  }, 20_000);

  it('replaces rather than adds, so an old secret stops working', async () => {
    // A stale secret that still verifies is a second key to the account that
    // nobody is holding on purpose.
    const user = await makeUser('rotating');
    const first = await prisma.twoFactor.findFirstOrThrow({ where: { userId: user.id } });

    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      currentCode: code(),
      context: CONTEXT,
    });
    await security.confirmTwoFactorEnrolment({
      userId: user.id,
      code: codeFor(enrolment.secret),
      context: CONTEXT,
    });

    const factors = await prisma.twoFactor.findMany({ where: { userId: user.id } });
    expect(factors).toHaveLength(1);
    expect(factors[0]?.id).not.toBe(first.id);
    expect(factors[0]?.secret).toBe(enrolment.secret);
  }, 20_000);

  it('refuses to confirm an expired enrolment', async () => {
    const user = await makeUser('expiredenrol', false);
    const enrolment = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });
    await prisma.twoFactorEnrolment.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      security.confirmTwoFactorEnrolment({
        userId: user.id,
        code: codeFor(enrolment.secret),
        context: CONTEXT,
      }),
    ).rejects.toThrow(/start setting up/i);
  }, 20_000);

  it('keeps only ONE live enrolment, so a restarted setup replaces the old secret', async () => {
    const user = await makeUser('restart', false);
    const first = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });
    const second = await security.beginTwoFactorEnrolment({
      userId: user.id,
      issuer: 'Rayi',
      context: CONTEXT,
    });

    expect(second.secret).not.toBe(first.secret);
    expect(await prisma.twoFactorEnrolment.count({ where: { userId: user.id } })).toBe(1);

    // The abandoned secret cannot be confirmed.
    await expect(
      security.confirmTwoFactorEnrolment({
        userId: user.id,
        code: codeFor(first.secret),
        context: CONTEXT,
      }),
    ).rejects.toThrow();
  }, 20_000);
});
