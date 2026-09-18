import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { ReviewService, UNDO_WINDOW_MS } from '../src/api/deals/review.service';
import { AuditService } from '../src/audit/audit.service';
import { PermissionService } from '../src/authorization/permission.service';
import type { PrismaService } from '../src/database/prisma.service';

/**
 * The review queue.
 *
 * Written as the four ways this design would have released money wrongly, which
 * the campaign-domain critique found:
 *
 *   1. Counting SUBMISSIONS instead of deliverables — a deliverable with two
 *      approved versions fires "N videos approved" early.
 *   2. Undo that deletes the review — impossible under append-only, and it
 *      erases the fact a decision was made.
 *   3. A second release path (the hard-deadline worker force-approving) that
 *      skips the index preventing double-pay.
 *   4. Approval gated only on a reviewer permission, when approving
 *      deterministically releases funds.
 */

const DATABASE_URL =
  process.env.LEDGER_TEST_DATABASE_URL ?? 'postgresql://rayi:rayi@localhost:55432/rayi';

const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
const prismaService = prisma as unknown as PrismaService;
const audit = new AuditService(prismaService);
const permissions = new PermissionService(prismaService);
const reviews = new ReviewService(prismaService, permissions, audit);

const CONTEXT = { requestId: 'req-1', ipAddress: '203.0.113.20', userAgent: 'test' };

let orgId: string;
let workspaceId: string;
let reviewer: string; // deliverable:review, NO money authority
let approver: string; // both
let creator: string;

interface Fixture {
  dealId: string;
  deliverableIds: string[];
  submissionIds: string[];
  milestoneIds: string[];
}

async function seedUser(label: string): Promise<string> {
  const run = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: `${run}-${label}@review.test`,
      username: `${run}-${label}`,
      isEmailVerified: true,
    },
  });
  return user.id;
}

/**
 * A deal with `deliverableCount` videos and milestones at the given cumulative
 * approval counts. `$100 for 20 videos`, scaled down.
 */
async function seedDeal(options: {
  deliverableCount: number;
  milestoneCounts: number[];
  totalMinor: bigint;
}): Promise<Fixture> {
  // A fresh campaign per deal. `@@unique([campaignId, creatorUserId])` allows
  // only one live deal per creator per campaign — two would make "what did we
  // agree" unanswerable and both would independently bound the payout — so the
  // fixture respects that rather than working around it.
  const campaign = await prisma.campaign.create({
    data: {
      organizationId: orgId,
      workspaceId,
      name: `C-${randomUUID().slice(0, 8)}`,
    },
  });

  const deal = await prisma.deal.create({
    data: {
      organizationId: orgId,
      campaignId: campaign.id,
      creatorUserId: creator,
      totalAmountMinor: options.totalMinor,
      state: 'active',
    },
  });

  const agreement = await prisma.agreementVersion.create({
    data: {
      dealId: deal.id,
      version: 1,
      totalAmountMinor: options.totalMinor,
      brandAcceptedAt: new Date(),
      brandAcceptedBy: approver,
      creatorAcceptedAt: new Date(),
    },
  });

  // Equal split, with the remainder on the last so the deferred balance trigger
  // is satisfied exactly.
  const share = options.totalMinor / BigInt(options.milestoneCounts.length);
  const amounts = options.milestoneCounts.map((_, index) =>
    index === options.milestoneCounts.length - 1
      ? options.totalMinor - share * BigInt(options.milestoneCounts.length - 1)
      : share,
  );

  const milestoneIds: string[] = [];
  for (const [index, count] of options.milestoneCounts.entries()) {
    const milestone = await prisma.milestone.create({
      data: {
        agreementVersionId: agreement.id,
        dealId: deal.id,
        sequence: index + 1,
        title: `Milestone ${index + 1}`,
        amountMinor: amounts[index]!,
        condition: { type: 'DELIVERABLES_APPROVED_COUNT', count },
      },
    });
    milestoneIds.push(milestone.id);
  }

  const deliverableIds: string[] = [];
  const submissionIds: string[] = [];
  for (let i = 0; i < options.deliverableCount; i += 1) {
    const deliverable = await prisma.deliverable.create({
      data: { dealId: deal.id, sequence: i + 1, state: 'in_review' },
    });
    const submission = await prisma.submission.create({
      data: { deliverableId: deliverable.id, version: 1, caption: `Video ${i + 1}` },
    });
    deliverableIds.push(deliverable.id);
    submissionIds.push(submission.id);
  }

  return { dealId: deal.id, deliverableIds, submissionIds, milestoneIds };
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;

  reviewer = await seedUser('reviewer');
  approver = await seedUser('approver');
  creator = await seedUser('creator');

  const run = randomUUID().slice(0, 12);
  const org = await prisma.organization.create({ data: { name: 'Acme', slug: `rev-${run}` } });
  orgId = org.id;

  const workspace = await prisma.workspace.create({
    data: { organizationId: orgId, name: 'W', slug: 'w' },
  });
  workspaceId = workspace.id;

  // Both are reviewers at ORG level; only one is trusted with funds.
  for (const userId of [reviewer, approver]) {
    const member = await prisma.member.create({
      data: { organizationId: orgId, userId, role: 'admin' },
    });
    if (userId === approver) {
      await prisma.moneyAuthority.create({
        data: {
          memberId: member.id,
          organizationId: orgId,
          capability: 'deliverable:release',
          limitMinor: 1_000_000n,
          grantedBy: approver,
        },
      });
    }
  }

  // `admin` needs deliverable:review for these tests to be about money rather
  // than about the role matrix.
  await prisma.rolePermission.upsert({
    where: {
      role_scope_permission: { role: 'admin', scope: 'org', permission: 'deliverable:review' },
    },
    create: { role: 'admin', scope: 'org', permission: 'deliverable:review' },
    update: {},
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('approval counts DELIVERABLES, never submissions', () => {
  it('a second approved version of the same deliverable does not count twice', async () => {
    // THE load-bearing constraint. Counting submissions would make "2 videos
    // approved" true after one video was revised and re-approved — a silent
    // overpay, with every constraint passing and the number wrong.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [2],
      totalMinor: 10_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: approver,
      context: CONTEXT,
    });

    // A revision of the SAME deliverable.
    const revision = await prisma.submission.create({
      data: { deliverableId: deal.deliverableIds[0]!, version: 2, caption: 'take two' },
    });

    // The deliverable is already approved, so this is refused outright — and the
    // partial unique index would refuse it even if this check were removed.
    await expect(
      reviews.approve({
        submissionId: revision.id,
        organizationId: orgId,
        actorUserId: approver,
        context: CONTEXT,
      }),
    ).rejects.toThrow(/already been approved/i);

    const approved = await prisma.deliverable.count({
      where: { dealId: deal.dealId, state: 'approved' },
    });
    expect(approved).toBe(1);
  }, 30_000);

  it('the DATABASE refuses two live approvals even if the code path is bypassed', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: approver,
      context: CONTEXT,
    });

    const second = await prisma.submission.create({
      data: { deliverableId: deal.deliverableIds[0]!, version: 2 },
    });

    // Straight to the table, as a future code path might.
    await expect(
      prisma.review.create({
        data: {
          submissionId: second.id,
          deliverableId: deal.deliverableIds[0]!,
          decision: 'APPROVED',
          actorKind: 'HUMAN',
          actorUserId: approver,
        },
      }),
    ).rejects.toThrow();
  }, 30_000);
});

describe('approval permission IS money authority in disguise', () => {
  it('lets a reviewer with NO money authority approve an ordinary deliverable', async () => {
    // The overwhelming majority of rows. The three-second review queue must not
    // need a money grant for these.
    const deal = await seedDeal({
      deliverableCount: 5,
      milestoneCounts: [5],
      totalMinor: 10_000n,
    });

    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    expect(outcome.satisfiedMilestoneIds).toEqual([]);
    expect(outcome.totalToReleaseMinor).toBe(0n);
  }, 30_000);

  it('REFUSES the approval that would tip a milestone', async () => {
    // Approving deterministically releases funds, so an approve button gated
    // only on a reviewer permission is a way to move money without ever holding
    // money authority.
    const deal = await seedDeal({
      deliverableCount: 2,
      milestoneCounts: [2],
      totalMinor: 50_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    // The SECOND one satisfies the milestone.
    await expect(
      reviews.approve({
        submissionId: deal.submissionIds[1]!,
        organizationId: orgId,
        actorUserId: reviewer,
        context: CONTEXT,
      }),
    ).rejects.toThrow(/release funds/i);

    // And nothing moved.
    const deliverable = await prisma.deliverable.findUniqueOrThrow({
      where: { id: deal.deliverableIds[1]! },
    });
    expect(deliverable.state).not.toBe('approved');
  }, 30_000);

  it('allows the same approval from someone WITH authority', async () => {
    const deal = await seedDeal({
      deliverableCount: 2,
      milestoneCounts: [2],
      totalMinor: 50_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[1]!,
      organizationId: orgId,
      actorUserId: approver,
      context: CONTEXT,
    });

    expect(outcome.satisfiedMilestoneIds).toHaveLength(1);
    expect(outcome.totalToReleaseMinor).toBe(50_000n);
  }, 30_000);

  it('enforces the per-transaction LIMIT on the amount this approval releases', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      // Above the approver's 1,000,000 limit.
      totalMinor: 5_000_000n,
    });

    await expect(
      reviews.approve({
        submissionId: deal.submissionIds[0]!,
        organizationId: orgId,
        actorUserId: approver,
        context: CONTEXT,
      }),
    ).rejects.toThrow(/approval limit/i);
  }, 30_000);

  it('records the amount an approval put in motion', async () => {
    // "Who authorised this payment" must be answerable, and the answer is
    // whoever pressed approve.
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 30_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: approver,
      context: CONTEXT,
    });

    const events = await prisma.$queryRawUnsafe<Array<{ data: Record<string, unknown> }>>(
      `SELECT data FROM audit.event
        WHERE action = 'deliverable.approved' AND subject_id = $1`,
      deal.deliverableIds[0]!,
    );
    expect(events[0]?.data).toMatchObject({ releasesMinor: '30000', actorKind: 'HUMAN' });
  }, 30_000);
});

describe('undo VOIDS, never deletes', () => {
  it('leaves the review row in place with voidedAt set', async () => {
    // Deleting is impossible under the append-only discipline, and it would
    // erase the fact that a decision was made — which a dispute needs.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });

    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    await reviews.undoApproval({
      reviewId: outcome.reviewId,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const review = await prisma.review.findUniqueOrThrow({ where: { id: outcome.reviewId } });
    expect(review.decision).toBe('APPROVED');
    expect(review.voidedAt).not.toBeNull();
    expect(review.voidedBy).toBe(reviewer);
  }, 30_000);

  it('frees the deliverable to be approved again', async () => {
    // The partial unique index ignores voided rows, which is what makes undo
    // possible without deleting anything.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });

    const first = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });
    await reviews.undoApproval({
      reviewId: first.reviewId,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const second = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    expect(second.reviewId).not.toBe(first.reviewId);
    // BOTH rows survive, so the history shows the approval, the undo, and the
    // re-approval.
    expect(await prisma.review.count({ where: { deliverableId: deal.deliverableIds[0]! } })).toBe(
      2,
    );
  }, 30_000);

  it('returns the deliverable to in_review, not to pending', async () => {
    // The work was submitted and is still submitted; only the decision was
    // withdrawn.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });

    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });
    await reviews.undoApproval({
      reviewId: outcome.reviewId,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const deliverable = await prisma.deliverable.findUniqueOrThrow({
      where: { id: deal.deliverableIds[0]! },
    });
    expect(deliverable.state).toBe('in_review');
    expect(deliverable.approvedAt).toBeNull();
  }, 30_000);

  it('cannot be undone twice', async () => {
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });
    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    await reviews.undoApproval({
      reviewId: outcome.reviewId,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });
    await expect(
      reviews.undoApproval({
        reviewId: outcome.reviewId,
        organizationId: orgId,
        actorUserId: reviewer,
        context: CONTEXT,
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('refuses to have its createdAt moved, because that would forge the window', async () => {
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });
    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    await expect(
      prisma.review.update({
        where: { id: outcome.reviewId },
        data: { createdAt: new Date(0) },
      }),
    ).rejects.toThrow(/immutable/);
  }, 30_000);

  it('REFUSES once the release window has passed', async () => {
    // Honest refusal beats an undo that sometimes silently does nothing.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });
    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    // Backdating needs the immutability trigger off, because `createdAt` is part
    // of what a review promises — a decision whose timestamp can be moved is a
    // decision that can be forged. The trigger refusing this is itself correct,
    // so the test disables it explicitly rather than the constraint being
    // loosened to make a test convenient.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "review" DISABLE TRIGGER review_decision_immutable`,
    );
    try {
      await prisma.review.update({
        where: { id: outcome.reviewId },
        data: { createdAt: new Date(Date.now() - UNDO_WINDOW_MS - 1_000) },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "review" ENABLE TRIGGER review_decision_immutable`,
      );
    }

    await expect(
      reviews.undoApproval({
        reviewId: outcome.reviewId,
        organizationId: orgId,
        actorUserId: reviewer,
        context: CONTEXT,
      }),
    ).rejects.toThrow(/too late/i);
  }, 30_000);

  it('cannot undo an approval in another organization', async () => {
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });
    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const otherOrg = await prisma.organization.create({
      data: { name: 'Rival', slug: `rival-${randomUUID().slice(0, 12)}` },
    });

    await expect(
      reviews.undoApproval({
        reviewId: outcome.reviewId,
        organizationId: otherOrg.id,
        actorUserId: reviewer,
        context: CONTEXT,
      }),
    ).rejects.toThrow(/no such approval/i);
  }, 30_000);
});

describe('the automatic path goes through the SAME code', () => {
  it('records a SYSTEM_AUTO review rather than force-approving', async () => {
    // The hard-deadline worker previously force-approved the deliverable without
    // inserting a Review, bypassing the one index that prevents double-pay. It
    // now uses this identical path.
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });

    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: 'system',
      actorKind: 'SYSTEM_AUTO',
      context: CONTEXT,
    });

    const review = await prisma.review.findUniqueOrThrow({ where: { id: outcome.reviewId } });
    expect(review.actorKind).toBe('SYSTEM_AUTO');
    // A system decision does not pretend to have an author.
    expect(review.actorUserId).toBeNull();
  }, 30_000);

  it('is still subject to the one-live-approval index', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });

    await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: approver,
      context: CONTEXT,
    });

    await expect(
      reviews.approve({
        submissionId: deal.submissionIds[0]!,
        organizationId: orgId,
        actorUserId: 'system',
        actorKind: 'SYSTEM_AUTO',
        context: CONTEXT,
      }),
    ).rejects.toThrow();
  }, 30_000);
});

describe('requesting changes', () => {
  it('never satisfies a milestone, so it needs no money authority', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 5_000_000n, // far above the approver's limit
    });

    await expect(
      reviews.requestChanges({
        submissionId: deal.submissionIds[0]!,
        organizationId: orgId,
        actorUserId: reviewer,
        comment: 'Please reshoot the opening.',
        context: CONTEXT,
      }),
    ).resolves.toMatchObject({ reviewId: expect.any(String) });

    const deliverable = await prisma.deliverable.findUniqueOrThrow({
      where: { id: deal.deliverableIds[0]! },
    });
    expect(deliverable.state).toBe('changes_requested');
  }, 30_000);

  it('does not block a later approval, because it is not a live APPROVED row', async () => {
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });

    await reviews.requestChanges({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    const revision = await prisma.submission.create({
      data: { deliverableId: deal.deliverableIds[0]!, version: 2 },
    });

    await expect(
      reviews.approve({
        submissionId: revision.id,
        organizationId: orgId,
        actorUserId: reviewer,
        context: CONTEXT,
      }),
    ).resolves.toBeDefined();
  }, 30_000);
});

describe('the database refuses states and decisions it does not know', () => {
  it('rejects an unknown review decision', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });

    // A typo'd decision is a review that no query matches and no milestone
    // counts — invisible rather than wrong, which is worse.
    await expect(
      prisma.review.create({
        data: {
          submissionId: deal.submissionIds[0]!,
          deliverableId: deal.deliverableIds[0]!,
          decision: 'APROVED',
          actorKind: 'HUMAN',
          actorUserId: reviewer,
        },
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('rejects an unknown milestone condition type', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });
    const milestone = await prisma.milestone.findFirstOrThrow({ where: { dealId: deal.dealId } });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "milestone" SET condition = '{"type":"PAY_WHENEVER"}'::jsonb WHERE id = $1`,
        milestone.id,
      ),
    ).rejects.toThrow(/milestone_condition_type_known/);
  }, 30_000);

  it('refuses to edit a RELEASED milestone', async () => {
    // Once money has left, the amount and condition are history. Editing either
    // makes the ledger entry unexplainable.
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });
    const milestone = await prisma.milestone.findFirstOrThrow({ where: { dealId: deal.dealId } });

    await prisma.milestone.update({
      where: { id: milestone.id },
      data: { releasedAt: new Date() },
    });

    await expect(
      prisma.milestone.update({
        where: { id: milestone.id },
        data: { amountMinor: 1n },
      }),
    ).rejects.toThrow(/already been released/);
  }, 30_000);

  it('refuses to edit a submission, because a revision is a new version', async () => {
    const deal = await seedDeal({
      deliverableCount: 1,
      milestoneCounts: [1],
      totalMinor: 10_000n,
    });

    await expect(
      prisma.submission.update({
        where: { id: deal.submissionIds[0]! },
        data: { caption: 'edited' },
      }),
    ).rejects.toThrow(/immutable/);
  }, 30_000);

  it('refuses to change a review DECISION', async () => {
    const deal = await seedDeal({
      deliverableCount: 3,
      milestoneCounts: [3],
      totalMinor: 10_000n,
    });
    const outcome = await reviews.approve({
      submissionId: deal.submissionIds[0]!,
      organizationId: orgId,
      actorUserId: reviewer,
      context: CONTEXT,
    });

    // Changing your mind is a new review after voiding the old one, so the
    // history shows both.
    await expect(
      prisma.review.update({
        where: { id: outcome.reviewId },
        data: { decision: 'REJECTED' },
      }),
    ).rejects.toThrow(/immutable/);
  }, 30_000);
});
