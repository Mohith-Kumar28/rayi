import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { WorkspacesService } from '../src/api/workspaces/workspaces.service';
import { AuditService } from '../src/audit/audit.service';
import type { PrismaService } from '../src/database/prisma.service';
import type { StepUpService } from '../src/auth/step-up/step-up.service';

/**
 * The budget envelope.
 *
 * Written as the ways a ceiling fails to be a ceiling:
 *
 *   1. Two concurrent commitments that both read the same remaining figure and
 *      both pass — the classic read-then-write race, and the reason draw-down is
 *      a conditional UPDATE guarded by a CHECK rather than application logic.
 *   2. An exhausted ceiling that stops deals ALREADY ACCEPTED, instead of only
 *      new ones. A creator must never lose their milestone because somebody else
 *      spent the budget.
 *   3. An expired envelope that keeps authorising.
 *   4. A ceiling lowered below what is committed, which would make the stored
 *      numbers disagree with the deals that are running.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);

// Step-up is exercised by its own suite. Here it is a pass-through, so these
// tests are about the ceiling rather than about the second factor.
const stepUp = {
  mint: async () => undefined,
  consume: async () => undefined,
} as unknown as StepUpService;

const service = new WorkspacesService(prismaService, stepUp, audit);

async function seed() {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();

  await prisma.organization.create({
    data: { id: organizationId, name: 'Test brand', slug: `t-${organizationId.slice(0, 8)}` },
  });
  await prisma.workspace.create({
    data: { id: workspaceId, organizationId, name: 'Core', slug: 'core' },
  });

  return { organizationId, workspaceId };
}

describe('budget envelope', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses a commitment when there is no envelope at all', async () => {
    const { organizationId, workspaceId } = await seed();
    // No envelope means nothing is approved, which must NOT read as unlimited.
    await expect(service.tryCommit(organizationId, workspaceId, 1_000n)).resolves.toBe(false);
  });

  it('commits beneath the ceiling and refuses above it', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: { workspaceId, organizationId, ceilingMinor: 10_000n, updatedAt: new Date() },
    });

    await expect(service.tryCommit(organizationId, workspaceId, 6_000n)).resolves.toBe(true);
    await expect(service.tryCommit(organizationId, workspaceId, 6_000n)).resolves.toBe(false);

    const envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
    // The refused commitment left nothing behind.
    expect(envelope.committedMinor).toBe(6_000n);
  });

  /**
   * The race the CHECK constraint exists for.
   *
   * Both callers read a remaining figure that can fund one of them. An
   * application-side `if (remaining >= amount)` passes for both; the database
   * lets exactly one through.
   *
   * **The rejection is asserted, not swallowed.** A `.catch(() => null)` here is
   * how a real double-write defect stayed hidden through a green suite.
   */
  it('lets exactly one of two concurrent commitments through', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: { workspaceId, organizationId, ceilingMinor: 10_000n, updatedAt: new Date() },
    });

    const results = await Promise.all([
      service.tryCommit(organizationId, workspaceId, 7_000n),
      service.tryCommit(organizationId, workspaceId, 7_000n),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);

    const envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
    expect(envelope.committedMinor).toBe(7_000n);
    expect(envelope.committedMinor).toBeLessThanOrEqual(envelope.ceilingMinor);
  });

  it('refuses a commitment against an expired envelope', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: {
        workspaceId,
        organizationId,
        ceilingMinor: 100_000n,
        expiresAt: new Date(Date.now() - 1000),
        updatedAt: new Date(),
      },
    });

    // Plenty of headroom, but the approval has lapsed. An expired envelope
    // behaves exactly like an exhausted one.
    await expect(service.tryCommit(organizationId, workspaceId, 1_000n)).resolves.toBe(false);
  });

  it('releases only what was uncommitted, and never below zero', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: {
        workspaceId,
        organizationId,
        ceilingMinor: 10_000n,
        committedMinor: 4_000n,
        updatedAt: new Date(),
      },
    });

    await service.release(organizationId, workspaceId, 3_000n);
    let envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
    expect(envelope.committedMinor).toBe(1_000n);

    // More than is committed. Refused rather than clamped: a release larger than
    // the commitment means the caller's arithmetic is wrong, and silently
    // flooring it would create headroom out of nothing.
    await service.release(organizationId, workspaceId, 5_000n);
    envelope = await prisma.budgetEnvelope.findUniqueOrThrow({ where: { workspaceId } });
    expect(envelope.committedMinor).toBe(1_000n);
  });

  /**
   * The storage engine, seen to refuse.
   *
   * The conditional UPDATE is what turns an over-commit into a clean `false`,
   * but the CHECK is the actual guarantee. A control only ever observed passing
   * is a control nobody knows still works, so this writes past the service and
   * asserts the database says no.
   */
  it('rejects an over-commit written directly, with a constraint violation', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: { workspaceId, organizationId, ceilingMinor: 1_000n, updatedAt: new Date() },
    });

    await expect(
      prisma.budgetEnvelope.update({
        where: { workspaceId },
        data: { committedMinor: 1_001n },
      }),
    ).rejects.toThrow(/budget_envelope_within_ceiling/);
  });

  it('refuses a ceiling below what is already committed', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: {
        workspaceId,
        organizationId,
        ceilingMinor: 10_000n,
        committedMinor: 8_000n,
        updatedAt: new Date(),
      },
    });

    await expect(
      service.setEnvelope(
        organizationId,
        workspaceId,
        { ceilingMinor: 5_000n, currency: 'USD', expiresAt: null, code: '000000' },
        'user-1',
        {},
      ),
      // Lowering a ceiling claws nothing back. Accepting this would only make
      // the stored numbers disagree with the deals that are running.
    ).rejects.toThrow(/already committed/i);
  });

  it('never reports a negative remaining, even when over-committed', async () => {
    const { organizationId, workspaceId } = await seed();
    await prisma.budgetEnvelope.create({
      data: {
        workspaceId,
        organizationId,
        ceilingMinor: 10_000n,
        committedMinor: 10_000n,
        updatedAt: new Date(),
      },
    });

    const [workspace] = await service.list(organizationId);
    // A negative "left to commit" on a screen reads as money available.
    expect(workspace?.envelope?.remainingMinor).toBe(0n);
  });
});
