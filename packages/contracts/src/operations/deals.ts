import { z } from 'zod';

import { MoneyInputSchema, MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * Deals, from the brand's side.
 *
 * A deal is the contract between ONE brand and ONE creator — "$2,400 for 20
 * videos". Milestones attach to the deal, never to the campaign, because six
 * things are per-creator and cannot be expressed a level up: terms differ per
 * creator in the same campaign; the payout bound `released <= total` needs a
 * per-creator ceiling; the Stripe connected account and 1099 identity are
 * per-creator; acceptance and termination are independent of the campaign; the
 * same creator appears in many campaigns; and an amendment needs both parties'
 * consent, which is only meaningful bilaterally.
 */

const OrgParams = z.object({ orgId: z.uuid() });
const DealParams = OrgParams.extend({ dealId: z.uuid() });

/**
 * The CLOSED condition catalogue.
 *
 * Brand-authored does not mean arbitrary user logic. A general rule engine on
 * this surface is a security and auditability hazard, so conditions come from a
 * fixed parameterised set — mirrored exactly from `ConditionType` in
 * `@rayi/domain`, which is what actually evaluates them.
 *
 * Two properties are registry-level requirements for anything added later, not
 * coincidences of the current six:
 *
 * **MONOTONIC** — once true, true forever. Payout is final, so a milestone that
 * satisfies, releases, then un-satisfies is an unrecoverable state the engine
 * must be unable to reach. It is also what makes concurrent re-evaluation
 * trivially safe.
 *
 * **CUMULATIVE counting** — `DELIVERABLES_APPROVED_COUNT` means "total approved
 * across the deal >= N", so a tranche schedule is M1(5), M2(12), M3(20).
 * Incremental counting would require remembering which approvals were consumed
 * by which milestone, making evaluation order-dependent and non-idempotent.
 *
 * And the count is of DELIVERABLES in state APPROVED, never of approved
 * submissions — a deliverable with two approved versions would otherwise count
 * twice and fire a milestone early, which is a silent overpay.
 */
export const MilestoneConditionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('ADVANCE') })
    .describe('Satisfied immediately. Not a special entity — a condition that is trivially true.'),
  z.object({
    type: z.literal('DELIVERABLES_APPROVED_COUNT'),
    count: z.int().min(0),
  }),
  z.object({
    type: z.literal('SPECIFIC_DELIVERABLES_APPROVED'),
    deliverableIds: z.array(z.uuid()).min(1),
  }),
  z.object({ type: z.literal('ALL_DELIVERABLES_APPROVED') }),
  z.object({ type: z.literal('DATE_REACHED'), date: z.iso.datetime() }),
  z
    .object({ type: z.literal('MANUAL_BRAND_APPROVAL') })
    .describe(
      'The escape hatch that removes the pressure to build a DSL. A brand with an uncatalogued ' +
        'condition can always express it as "I will approve this myself".',
    ),
]);

/**
 * A milestone as the brand AUTHORS it.
 *
 * The amount is either fixed minor units or a percentage of deal value. Both
 * are first-class, and a percentage is authoring input — **never the
 * authoritative value**. At acceptance every milestone resolves to integer
 * minor units, the largest-remainder rule distributes the odd cents, and the
 * resolved amounts are frozen on the row.
 */
export const MilestoneInputSchema = z.object({
  title: z.string().min(1).max(120),
  /** Exactly one of these. Enforced server-side where the deal total is known. */
  amount: MoneyInputSchema.optional(),
  /** Basis points — 2500 is 25%. An integer, so no float ever touches a share of money. */
  percentageBps: z.int().min(1).max(10_000).optional(),
  condition: MilestoneConditionSchema,
});

/**
 * A milestone as the SERVER resolved it.
 *
 * `amount` here is the frozen figure. Percentages are never re-evaluated at
 * release time: if they were, amending a deal total would silently change the
 * amount of an ALREADY-RELEASED milestone — a retroactive rewrite of money that
 * has left. The stored percentage survives for display and for authoring the
 * next version only.
 */
export const ResolvedMilestoneSchema = z.object({
  milestoneId: z.uuid(),
  title: z.string(),
  amount: MoneySchema,
  percentageBps: z.int().nullable(),
  condition: MilestoneConditionSchema,
  satisfied: z.boolean(),
  /** The engine's own sentence. Same function that decides whether money moves. */
  reason: z.string(),
  /** Set only once money has actually moved. Never set optimistically. */
  releasedAt: z.iso.datetime().nullable(),
  /**
   * Whether this milestone would be satisfied against an EMPTY deal.
   *
   * Derived, not declared — so a brand cannot sidestep the disclosure by
   * expressing an advance a different way. `count: 0` and a date already in the
   * past are caught by the same check that catches `ADVANCE`.
   */
  satisfiableAtStart: z.boolean(),
});

export const DealStateSchema = z.enum([
  'draft',
  'offered',
  'accepted',
  'active',
  'completed',
  'cancelled',
  'terminated',
]);

export const DealSummarySchema = z.object({
  dealId: z.uuid(),
  campaignId: z.uuid(),
  campaignName: z.string(),
  creatorId: z.uuid(),
  creatorHandle: z.string(),
  state: DealStateSchema,
  total: MoneySchema,
  /** Money that has actually moved. Never anything merely approved. */
  released: MoneySchema,
  deliverablesTotal: z.int(),
  deliverablesApproved: z.int(),
  createdAt: z.iso.datetime(),
  /** Null until the creator accepts. An offer is not a deal. */
  acceptedAt: z.iso.datetime().nullable(),
});

export const listDeals = defineOperation({
  operationId: 'listDeals',
  method: 'get',
  path: '/v1/orgs/{orgId}/deals',
  summary: 'Every deal in an organization',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:read' },
  pathParams: OrgParams,
  query: z.object({
    campaignId: z.uuid().optional(),
    state: DealStateSchema.optional(),
    creatorId: z.uuid().optional(),
  }),
  successStatus: 200,
  response: z.object({
    deals: z.array(DealSummarySchema),
    /**
     * Totals across the FILTERED set, computed server-side.
     *
     * Not summed in the browser. A client that adds up money is a client that
     * can disagree with the ledger, and the disagreement shows up as a figure
     * somebody screenshots.
     *
     * **`committed` counts only `offered`, `accepted` and `active` deals** —
     * the states where money is actually held against the campaign and not yet
     * paid. A draft promises nobody anything, a completed deal has already been
     * paid in full, and a terminated one returned its remainder. Summing every
     * deal's total and calling it "committed" would overstate a brand's
     * outstanding obligation by every deal they ever finished.
     */
    totals: z.object({ committed: MoneySchema, released: MoneySchema }),
  }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const DeliverableSpecSchema = z.object({
  slot: z.string().min(1).max(80).describe('"Video 3 of 20" — what the brand actually bought.'),
  brief: z.string().max(2000).nullable(),
  dueAt: z.iso.datetime().nullable(),
});

export const DealDetailSchema = DealSummarySchema.extend({
  milestones: z.array(ResolvedMilestoneSchema),
  deliverables: z.array(
    z.object({
      deliverableId: z.uuid(),
      slot: z.string(),
      brief: z.string().nullable(),
      state: z.enum([
        'pending',
        'submitted',
        'in_review',
        'changes_requested',
        'approved',
        'cancelled',
      ]),
      latestVersion: z.int(),
      dueAt: z.iso.datetime().nullable(),
    }),
  ),
  /**
   * The agreement history.
   *
   * An accepted agreement is IMMUTABLE and an amendment is a new version
   * requiring both signatures, so this is a list rather than a field.
   */
  agreementVersions: z.array(
    z.object({
      version: z.int(),
      createdAt: z.iso.datetime(),
      acceptedAt: z.iso.datetime().nullable(),
      total: MoneySchema,
    }),
  ),
});

export const getDeal = defineOperation({
  operationId: 'getDeal',
  method: 'get',
  path: '/v1/orgs/{orgId}/deals/{dealId}',
  summary: 'One deal',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:read' },
  pathParams: DealParams,
  successStatus: 200,
  response: DealDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const DealDraftSchema = z.object({
  campaignId: z.uuid(),
  creatorHandle: z.string().min(1).max(60),
  total: MoneyInputSchema,
  deliverables: z.array(DeliverableSpecSchema).min(1).max(200),
  /**
   * May be empty.
   *
   * A deal with no milestones is a deal with one final milestone paying the
   * whole total on `ALL_DELIVERABLES_APPROVED`, and creating that case must stay
   * a one-step action rather than forcing a brand through a schedule builder to
   * express the ordinary thing.
   */
  milestones: z.array(MilestoneInputSchema).max(20),
});

/**
 * Resolve a draft WITHOUT creating anything.
 *
 * This is what makes the authoring UI unable to lie. The percentages, the odd
 * cents, the advance disclosure and the "does this add up" check are all
 * answered by the server — by the same `resolveMilestoneAmounts` and
 * `isSatisfiableAtStart` the real acceptance path uses — so the preview a brand
 * consents to is the arithmetic that will actually be frozen.
 *
 * A client-side preview would be a second implementation of money arithmetic,
 * and the two would disagree on exactly the inputs nobody tested.
 */
export const previewDeal = defineOperation({
  operationId: 'previewDeal',
  method: 'post',
  path: '/v1/orgs/{orgId}/deals/preview',
  summary: 'Resolve a deal draft without creating it',
  description:
    'Returns the milestone amounts as they would be frozen, the odd-cent distribution, and which ' +
    'milestones are satisfiable at t=0 — money that leaves before work exists and cannot be ' +
    'recovered. Creates nothing and moves nothing.',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:create' },
  pathParams: OrgParams,
  body: DealDraftSchema,
  successStatus: 200,
  response: z.object({
    milestones: z.array(
      z.object({
        title: z.string(),
        amount: MoneySchema,
        percentageBps: z.int().nullable(),
        condition: MilestoneConditionSchema,
        satisfiableAtStart: z.boolean(),
        reason: z.string(),
      }),
    ),
    /** `SUM(milestone.amount)`, server-computed, to compare against the total. */
    milestoneTotal: MoneySchema,
    total: MoneySchema,
    balances: z.boolean().describe('Whether the milestones sum exactly to the deal total.'),
    /**
     * What leaves before any work exists.
     *
     * Surfaced as its own figure because this is the number the brand is
     * actually consenting to when they accept the advance disclosure.
     */
    advanceTotal: MoneySchema,
    /** Blocking problems, in words. Empty means the draft can be offered. */
    problems: z.array(z.string()),
  }),
  errors: ['unauthenticated', 'forbidden', 'not_found', 'validation_failed'],
});

export const createDeal = defineOperation({
  operationId: 'createDeal',
  method: 'post',
  path: '/v1/orgs/{orgId}/deals',
  summary: 'Create a deal in draft',
  description: 'Creates a draft. Nothing is offered to the creator and no money is committed.',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:create' },
  pathParams: OrgParams,
  body: DealDraftSchema,
  successStatus: 201,
  response: DealDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const OfferDealBodySchema = z.object({
  /**
   * The advance the brand has seen and accepted, in minor units.
   *
   * An ASSERTION, never an instruction. The server re-derives the advance from
   * the deal and refuses on mismatch, so a stale authoring screen cannot consent
   * on a brand's behalf to money that leaves before work exists.
   */
  acknowledgedAdvanceMinor: z.string().regex(/^(0|[1-9][0-9]*)$/),
  /** Required only when the advance is non-zero. */
  code: z.string().min(6).max(12).optional(),
});

export const offerDeal = defineOperation({
  operationId: 'offerDeal',
  method: 'post',
  path: '/v1/orgs/{orgId}/deals/{dealId}/offer',
  summary: 'Send the deal to the creator',
  description:
    'Commits the deal against the campaign allocation and sends the offer. A deal with an advance ' +
    'needs step-up, because accepting it means money leaves before any work exists.',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:offer', stepUp: true, movesMoney: true },
  pathParams: DealParams,
  body: OfferDealBodySchema,
  successStatus: 202,
  response: z.object({ dealId: z.uuid(), state: DealStateSchema, offeredAt: z.iso.datetime() }),
  errors: [
    'unauthenticated',
    'forbidden',
    'step_up_required',
    'not_found',
    'conflict',
    'insufficient_unallocated_funds',
    'budget_envelope_exceeded',
    'validation_failed',
  ],
});

export const TerminateDealBodySchema = z.object({
  reason: z.string().min(1).max(500),
  code: z.string().min(6).max(12),
});

export const terminateDeal = defineOperation({
  operationId: 'terminateDeal',
  method: 'post',
  path: '/v1/orgs/{orgId}/deals/{dealId}/terminate',
  summary: 'End a deal early',
  description:
    'Releases nothing and claws nothing back. Already-released milestones stay released — payout ' +
    'is final — and the uncommitted remainder returns to the campaign allocation.',
  tags: ['deals'],
  access: { kind: 'permission', permission: 'deal:terminate', stepUp: true },
  pathParams: DealParams,
  body: TerminateDealBodySchema,
  successStatus: 202,
  response: z.object({ dealId: z.uuid(), state: DealStateSchema, returned: MoneySchema }),
  errors: [
    'unauthenticated',
    'forbidden',
    'step_up_required',
    'not_found',
    'conflict',
    'validation_failed',
  ],
});

export const DEAL_OPERATIONS = [
  listDeals,
  getDeal,
  previewDeal,
  createDeal,
  offerDeal,
  terminateDeal,
] as const;
