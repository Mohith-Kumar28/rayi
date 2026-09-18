import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../src/audit/audit.service';
import { AuditAction } from '../src/audit/audit.types';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * The audit log, and proof that tampering is detectable.
 *
 * "Append-only" is a claim about grants and triggers. "Tamper-evident" is a
 * claim about the hash chain. They protect against different attackers — the
 * triggers stop the application, the chain stops whoever gets past the triggers
 * — so both are tested, and the chain is tested by actually breaking it.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ??
  'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const audit = new AuditService(prisma as unknown as PrismaService);

const run = randomUUID().slice(0, 8);
let userId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-audit@test.local`,
      username: `${run}-audit`,
      isEmailVerified: true,
    },
  });
  userId = user.id;
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recording events', () => {
  it('writes an event and returns its id', async () => {
    const id = await audit.record({
      action: AuditAction.SessionRevoked,
      actorUserId: userId,
      subjectType: 'session',
      subjectId: 'sess-1',
      ipAddress: '203.0.113.10',
      data: { reason: 'user_requested' },
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const events = await audit.forUser(userId);
    expect(events[0]?.action).toBe('session.revoked');
    expect(events[0]?.data).toEqual({ reason: 'user_requested' });
    expect(events[0]?.ipAddress).toBe('203.0.113.10');
  }, 20_000);

  it('shows a user only their own events', async () => {
    const other = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `${run}-other@test.local`,
        username: `${run}-other`,
        isEmailVerified: true,
      },
    });

    await audit.record({
      action: AuditAction.ProfileUpdated,
      actorUserId: other.id,
      data: { fields: ['bio'] },
    });

    const mine = await audit.forUser(userId);
    expect(mine.every((event) => event.actorUserId === userId)).toBe(true);
  }, 20_000);

  it('refuses an action name that is not in the enumerated shape', async () => {
    // Free-text action names are how an event ends up matching no alert and no
    // search. The CHECK constraint is what makes that impossible rather than
    // merely discouraged.
    await expect(
      prisma.$queryRawUnsafe(`SELECT audit.record('Not A Valid Action')`),
    ).rejects.toThrow(/audit_event_action_shape/);
  }, 20_000);

  it('never throws from record(), even when the write fails', async () => {
    // An audit failure must not roll back the action it was recording. Refusing
    // to revoke a session because the log was unavailable would turn an
    // observability outage into a security one, at exactly the wrong moment.
    const broken = new AuditService({
      $queryRaw: () => Promise.reject(new Error('database is on fire')),
    } as unknown as PrismaService);

    await expect(
      broken.record({
        action: AuditAction.SessionRevoked,
        actorUserId: userId,
      }),
    ).resolves.toBeNull();
  }, 20_000);

  it('DOES throw from recordInTransaction(), for events that must be atomic', async () => {
    // Granting money capability without a record is worse than not granting it.
    const broken = new AuditService(prisma as unknown as PrismaService);
    await expect(
      broken.recordInTransaction(
        {
          $queryRaw: () => Promise.reject(new Error('nope')),
        } as unknown as PrismaService,
        { action: AuditAction.MoneyAuthorityGranted, actorUserId: userId },
      ),
    ).rejects.toThrow();
  }, 20_000);
});

describe('the log cannot be rewritten through SQL', () => {
  it('refuses UPDATE', async () => {
    await audit.record({
      action: AuditAction.ProfileUpdated,
      actorUserId: userId,
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit.event SET action = 'account.profile_updated'`,
      ),
    ).rejects.toThrow(/append-only/);
  }, 20_000);

  it('refuses DELETE', async () => {
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM audit.event`),
    ).rejects.toThrow(/append-only/);
  }, 20_000);
});

describe('and tampering that bypasses those triggers is DETECTABLE', () => {
  it('verifies clean on an untouched chain', async () => {
    for (let i = 0; i < 5; i += 1) {
      await audit.record({
        action: AuditAction.SessionRevoked,
        actorUserId: userId,
        subjectId: `sess-${i}`,
        ipAddress: '203.0.113.10',
      });
    }
    expect(await audit.verifyChain()).toEqual([]);
  }, 30_000);

  it('verifies clean even after a transaction that rolled back', async () => {
    // THE false positive an earlier version had. A rolled-back insert consumes a
    // sequence value and never gives it back, because sequences are deliberately
    // non-transactional. Treating the resulting gap as tampering meant the alarm
    // fired every time an ordinary request failed — and an alarm that fires on
    // honest data is one people learn to ignore before the day it matters.
    await expect(
      prisma.$queryRawUnsafe(`SELECT audit.record('NOT A VALID ACTION')`),
    ).rejects.toThrow();

    await audit.record({
      action: AuditAction.ProfileUpdated,
      actorUserId: userId,
    });

    expect(await audit.verifyChain()).toEqual([]);
  }, 30_000);

  it('catches a row whose contents were changed', async () => {
    const target = await prisma.$queryRawUnsafe<Array<{ seq: bigint }>>(
      `SELECT seq FROM audit.event ORDER BY seq DESC LIMIT 1`,
    );
    const seq = target[0]!.seq;

    // Disabling the trigger is what someone with database access does — which is
    // precisely the attacker the hash chain exists for. The triggers stop the
    // application; the chain stops whoever gets past them.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE audit.event SET data = '{"reason":"something_else"}'::jsonb WHERE seq = $1`,
        seq,
      );

      const breaks = await audit.verifyChain();
      expect(breaks).toHaveLength(1);
      expect(breaks[0]?.seq).toBe(seq);
      expect(breaks[0]?.reason).toMatch(/do not match its recorded hash/);
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit.event WHERE seq >= $1`,
        seq,
      );
      await prisma.$executeRawUnsafe(
        `ALTER TABLE audit.event ENABLE TRIGGER audit_event_append_only`,
      );
    }

    expect(await audit.verifyChain()).toEqual([]);
  }, 30_000);

  it('catches a row removed from the MIDDLE, via the broken link', async () => {
    for (let i = 0; i < 3; i += 1) {
      await audit.record({
        action: AuditAction.ProfileUpdated,
        actorUserId: userId,
      });
    }

    const rows = await prisma.$queryRawUnsafe<Array<{ seq: bigint }>>(
      `SELECT seq FROM audit.event ORDER BY seq DESC LIMIT 3`,
    );
    // The MIDDLE of the three. Removing the tail would leave a chain that still
    // verifies — a real limitation, covered by head() anchoring rather than
    // pretended away.
    const middle = rows[1]!.seq;

    await prisma.$executeRawUnsafe(
      `ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit.event WHERE seq = $1`,
        middle,
      );

      const breaks = await audit.verifyChain();
      expect(breaks).toHaveLength(1);
      expect(breaks[0]?.reason).toMatch(/a row was removed or altered/);
    } finally {
      // Everything from the break onward is unreconstructable, which is the
      // correct real-world consequence too.
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit.event WHERE seq >= $1`,
        middle,
      );
      await prisma.$executeRawUnsafe(
        `ALTER TABLE audit.event ENABLE TRIGGER audit_event_append_only`,
      );
    }

    expect(await audit.verifyChain()).toEqual([]);
  }, 30_000);

  it('is honest that a truncated tail still verifies', async () => {
    // Stated as a test so the limitation is impossible to forget. A log cannot
    // prove from inside itself that it has not been truncated; only an anchor
    // published somewhere the database role cannot reach can show that.
    const headBefore = await audit.head();
    expect(headBefore).not.toBeNull();

    await prisma.$executeRawUnsafe(
      `ALTER TABLE audit.event DISABLE TRIGGER audit_event_append_only`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit.event WHERE seq = $1`,
        headBefore!.seq,
      );

      // The chain is still internally consistent. This is the gap.
      expect(await audit.verifyChain()).toEqual([]);

      // But the published head no longer exists, which is how it gets caught.
      const headAfter = await audit.head();
      expect(headAfter?.hash).not.toBe(headBefore!.hash);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE audit.event ENABLE TRIGGER audit_event_append_only`,
      );
    }
  }, 30_000);

  it('keeps chaining correctly after all that', async () => {
    const id = await audit.record({
      action: AuditAction.SessionsRevokedAll,
      actorUserId: userId,
    });
    expect(id).toBeTruthy();
    expect(await audit.verifyChain()).toEqual([]);
  }, 20_000);

  it('links each row to the one before it', async () => {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ prev: string; hash: string; seq: bigint }>
    >(
      `SELECT seq, encode(prev_hash,'hex') AS prev, encode(hash,'hex') AS hash
         FROM audit.event ORDER BY seq DESC LIMIT 2`,
    );
    expect(rows).toHaveLength(2);
    // The newest row's prev_hash IS the previous row's hash. That is the chain.
    expect(rows[0]?.prev).toBe(rows[1]?.hash);
  }, 20_000);

  it('hashes an IP address the same way it stores one', async () => {
    // The defect this whole pair of migrations exists for: `record` hashed the
    // input text `203.0.113.10` while the column rendered back `203.0.113.10/32`,
    // so every event carrying an IP — every security-relevant event — verified
    // as tampered.
    await audit.record({
      action: AuditAction.SessionRevoked,
      actorUserId: userId,
      ipAddress: '198.51.100.7',
    });
    await audit.record({
      action: AuditAction.SessionRevoked,
      actorUserId: userId,
      ipAddress: '2001:db8::1',
    });
    expect(await audit.verifyChain()).toEqual([]);
  }, 20_000);
});

describe('concurrent writers produce one chain, not a fork', () => {
  it('serializes ten simultaneous records', async () => {
    // Without the advisory lock, two writers read the same prev_hash and the
    // chain forks. A forked chain verifies as broken forever after, so this is
    // not a performance concern — it is the correctness of the whole structure.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        audit.record({
          action: AuditAction.ProfileUpdated,
          actorUserId: userId,
          data: { n: i },
        }),
      ),
    );

    expect(await audit.verifyChain()).toEqual([]);
  }, 30_000);
});
