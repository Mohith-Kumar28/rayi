import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The review queue — the brand's core loop.
 *
 * The product claim is three seconds per row, and the shape of these operations
 * is what makes that possible: the queue returns **exceptions** plus a single
 * summary of everything that cleared, rather than a list the reviewer has to
 * read. "Exceptions over lists" is not a phrase about design; it is why the
 * response has two halves.
 */

const OrgParams = z.object({ orgId: z.uuid() });

/** A check the verification pipeline ran on a submission. */
export const CheckResultSchema = z.object({
  name: z.string(),
  /**
   * PASS | FAIL | ERROR.
   *
   * `ERROR` is distinct from `FAIL` and never blocks. If ffprobe crashes, the
   * submission proceeds with the check shown as "could not verify" — a creator
   * must never be punished for our infrastructure. An ERROR that behaved like a
   * FAIL turns an ffmpeg OOM into a rejected creator and a dispute we deserve
   * to lose.
   */
  status: z.enum(['PASS', 'FAIL', 'ERROR']),
  /** BLOCKING checks bounce work back before it reaches this queue. */
  tier: z.enum(['BLOCKING', 'ADVISORY']),
  detail: z.string().nullable(),
});

export const QueueRowSchema = z.object({
  submissionId: z.uuid(),
  deliverableId: z.uuid(),
  dealId: z.uuid(),
  campaignName: z.string(),
  creatorHandle: z.string(),
  /** "Video 3 of 20". What the brand actually bought. */
  slot: z.string(),
  submissionVersion: z.int(),
  submittedAt: z.iso.datetime(),
  caption: z.string().nullable(),
  /** A derived rendition. Originals are evidence and are never served. */
  previewUrl: z.string().nullable(),
  checks: z.array(CheckResultSchema),
  /**
   * What approving this row would release, right now.
   *
   * Server-computed. The UI displays it so a reviewer can see that a row is
   * money rather than routine — but it is never sent back, and no amount a
   * client supplies can become an amount the server pays.
   */
  releasesOnApproval: MoneySchema.nullable(),
});

export const listReviewQueue = defineOperation({
  operationId: 'listReviewQueue',
  method: 'get',
  path: '/v1/orgs/{orgId}/review',
  summary: 'The review queue',
  description:
    'Returns EXCEPTIONS — rows with a failed or unverifiable check, or that would release funds — ' +
    'plus one summary of everything that cleared. A reviewer reads the exceptions and approves the ' +
    'rest in one action, which is what makes three seconds a row achievable.',
  tags: ['review'],
  access: { kind: 'permission', permission: 'deliverable:read' },
  pathParams: OrgParams,
  query: z.object({ campaignId: z.uuid().optional() }),
  successStatus: 200,
  response: z.object({
    exceptions: z.array(QueueRowSchema),
    /** Everything that passed every check and releases nothing. */
    cleared: z.object({
      count: z.int(),
      submissionIds: z.array(z.uuid()),
      /** Zero unless one of them would tip a milestone, in which case it is not cleared. */
      releasesTotal: MoneySchema,
    }),
  }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const ApproveBodySchema = z.object({
  comment: z.string().max(2000).optional(),
  /** S3 key of a voice note. Brands review faster by talking than typing. */
  voiceKey: z.string().max(500).optional(),
  /**
   * What the client believed approving this would release.
   *
   * An ASSERTION, never an instruction. The server compares it against its own
   * figure and refuses on mismatch, so a stale queue cannot approve an amount
   * the reviewer never saw.
   */
  expectedReleaseMinor: z.string().optional(),
});

export const ApprovalResultSchema = z.object({
  reviewId: z.uuid(),
  deliverableId: z.uuid(),
  satisfiedMilestoneIds: z.array(z.uuid()),
  /** What this approval put in motion. Zero for an ordinary review. */
  releases: MoneySchema,
  /**
   * When the release job may act. Until then the approval can be undone.
   *
   * The UI shows a truthful pending state — "Releasing in 0:58 · Undo" — and
   * never claims the money has moved, because it has not.
   */
  releasesAt: z.iso.datetime(),
});

export const approveSubmission = defineOperation({
  operationId: 'approveSubmission',
  method: 'post',
  path: '/v1/orgs/{orgId}/submissions/{submissionId}/approve',
  summary: 'Approve a submission',
  description:
    'Writes NO ledger entry. It transitions state and leaves the release to a job that runs after ' +
    'the undo window — so the api never does money work inline, and every approval has a ' +
    'genuinely cancellable undo that never touches Stripe. An approval that would satisfy a ' +
    'milestone additionally requires money authority.',
  tags: ['review'],
  access: {
    kind: 'permission',
    permission: 'deliverable:review',
    // True because approving can deterministically release funds 30 seconds
    // later. A route that moves money on a timer is still a route that moves
    // money.
    movesMoney: true,
  },
  pathParams: OrgParams.extend({ submissionId: z.uuid() }),
  body: ApproveBodySchema,
  successStatus: 200,
  response: ApprovalResultSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const requestChanges = defineOperation({
  operationId: 'requestChanges',
  method: 'post',
  path: '/v1/orgs/{orgId}/submissions/{submissionId}/request-changes',
  summary: 'Send work back for changes',
  description:
    'Never satisfies a milestone, so it needs no money authority — a reviewer without one can ' +
    'still do the majority of the job.',
  tags: ['review'],
  access: { kind: 'permission', permission: 'deliverable:review' },
  pathParams: OrgParams.extend({ submissionId: z.uuid() }),
  body: z.object({
    comment: z.string().min(1).max(2000),
    voiceKey: z.string().max(500).optional(),
  }),
  successStatus: 200,
  response: z.object({ reviewId: z.uuid() }),
  errors: ['unauthenticated', 'forbidden', 'not_found', 'validation_failed'],
});

export const undoApproval = defineOperation({
  operationId: 'undoApproval',
  method: 'post',
  path: '/v1/orgs/{orgId}/reviews/{reviewId}/undo',
  summary: 'Undo an approval before it releases',
  description:
    'Voids the review rather than deleting it, so the history shows the approval, the undo and any ' +
    're-approval. Refused once the window has passed — an undo that sometimes silently does ' +
    'nothing is worse than one that says it is too late.',
  tags: ['review'],
  access: { kind: 'permission', permission: 'deliverable:review' },
  pathParams: OrgParams.extend({ reviewId: z.uuid() }),
  successStatus: 200,
  response: z.object({ undone: z.boolean() }),
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict'],
});

export const REVIEW_OPERATIONS = [
  listReviewQueue,
  approveSubmission,
  requestChanges,
  undoApproval,
] as const;
