import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The creator surface.
 *
 * `access: { kind: 'self' }` throughout, and NO `{orgId}` anywhere — a creator
 * is not a member of the brand's organization. They are a counterparty to a
 * deal, and modelling them as a tenant member would give them a role in an
 * organization whose money they can see part of.
 *
 * The population this serves is the one that RECEIVES the money, and the one
 * with the weakest auth. Every control built for brands protects brands; these
 * endpoints are where that asymmetry shows, so they return only what a creator
 * needs and nothing about the brand's other deals, balances or reviewers.
 */

export const CreatorMilestoneSchema = z.object({
  milestoneId: z.uuid(),
  title: z.string(),
  amount: MoneySchema,
  satisfied: z.boolean(),
  /**
   * The engine's own sentence — "3 more videos need to be approved (7 of 10 so
   * far)".
   *
   * Produced by `evaluateDeal`, the same function that decides whether money
   * moves. One source, so this screen can never promise what the engine will not
   * do.
   */
  reason: z.string(),
  /** Set once money has actually moved. Never set optimistically. */
  releasedAt: z.iso.datetime().nullable(),
});

export const CreatorDeliverableSchema = z.object({
  deliverableId: z.uuid(),
  slot: z.string(),
  state: z.enum(['pending', 'submitted', 'in_review', 'changes_requested', 'approved', 'cancelled']),
  brief: z.string().nullable(),
  latestVersion: z.int(),
  /** The brand's most recent note. What the creator has to act on. */
  latestComment: z.string().nullable(),
});

export const CreatorDealSchema = z.object({
  dealId: z.uuid(),
  brandName: z.string(),
  campaignName: z.string(),
  state: z.enum(['draft', 'offered', 'accepted', 'active', 'completed', 'cancelled', 'terminated']),
  total: MoneySchema,
  /** Money that has actually moved. Never includes anything merely approved. */
  earned: MoneySchema,
  milestones: z.array(CreatorMilestoneSchema),
  deliverables: z.array(CreatorDeliverableSchema),
  /**
   * The single most useful thing on the screen: what unlocks the next payment.
   *
   * Null when everything is unlocked.
   */
  nextUnlock: CreatorMilestoneSchema.nullable(),
});

export const listMyDeals = defineOperation({
  operationId: 'listMyDeals',
  method: 'get',
  path: '/v1/me/deals',
  summary: 'The deals you are part of',
  description:
    'Returns only deals where you are the creator. Scoped by the session user in the WHERE clause, ' +
    'never by a parameter — there is no creator id in this path, and there must never be one.',
  tags: ['creator'],
  access: { kind: 'self' },
  successStatus: 200,
  response: z.object({ deals: z.array(CreatorDealSchema) }),
  errors: ['unauthenticated'],
});

export const getMyDeal = defineOperation({
  operationId: 'getMyDeal',
  method: 'get',
  path: '/v1/me/deals/{dealId}',
  summary: 'One of your deals',
  tags: ['creator'],
  access: { kind: 'self' },
  pathParams: z.object({ dealId: z.uuid() }),
  successStatus: 200,
  response: CreatorDealSchema,
  errors: ['unauthenticated', 'not_found'],
});

export const SubmitDeliverableBodySchema = z.object({
  /**
   * The key of an already-uploaded original.
   *
   * Upload goes DIRECT to S3 with a presigned POST, never through the API and
   * never with a client-chosen key — and completion is learned from the S3
   * event, not from this call. A client that could name its own key could
   * overwrite someone else's evidence.
   */
  assetKey: z.string().min(1).max(500),
  caption: z.string().max(2200).optional(),
});

export const submitDeliverable = defineOperation({
  operationId: 'submitDeliverable',
  method: 'post',
  path: '/v1/me/deliverables/{deliverableId}/submit',
  summary: 'Submit work for a deliverable',
  description:
    'Creates a NEW submission version. A revision never edits the previous attempt, because a ' +
    'dispute six months later must be able to show attempt 1, what was said about it, and attempt ' +
    '2 side by side.',
  tags: ['creator'],
  access: { kind: 'self' },
  pathParams: z.object({ deliverableId: z.uuid() }),
  body: SubmitDeliverableBodySchema,
  successStatus: 201,
  response: z.object({ submissionId: z.uuid(), version: z.int() }),
  errors: ['unauthenticated', 'not_found', 'conflict', 'validation_failed'],
});

export const CreatorEarningsSchema = z.object({
  /** Paid out to the creator's bank. Money that has left Rayi entirely. */
  paidOut: MoneySchema,
  /** Released and waiting for the next payout run. Real money, not yet moved. */
  awaitingPayout: MoneySchema,
  /**
   * Agreed but not yet unlocked.
   *
   * Deliberately NOT called "pending" or "earned". It is what the deals are
   * worth if the work is approved, and calling it anything stronger would be the
   * product telling a creator they have money they do not have.
   */
  agreedNotYetUnlocked: MoneySchema,
});

export const getMyEarnings = defineOperation({
  operationId: 'getMyEarnings',
  method: 'get',
  path: '/v1/me/earnings',
  summary: 'What you have earned',
  description:
    'Three figures that are deliberately distinct: paid out, released and awaiting the next payout ' +
    'run, and agreed but not yet unlocked. Collapsing them into one number would tell a creator ' +
    'they have money they cannot spend.',
  tags: ['creator'],
  access: { kind: 'self' },
  successStatus: 200,
  response: CreatorEarningsSchema,
  errors: ['unauthenticated'],
});

export const CREATOR_OPERATIONS = [
  listMyDeals,
  getMyDeal,
  submitDeliverable,
  getMyEarnings,
] as const;
