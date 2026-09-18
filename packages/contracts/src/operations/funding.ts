import { z } from 'zod';

import { MoneyInputSchema, MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * Funding and allocation operations — the first vertical slice.
 *
 * `orgId` is an explicit path parameter on every one of these, never an ambient
 * `activeOrganizationId` read from the session. That session field is shared
 * mutable state across browser tabs: an agency operator with two clients open
 * would otherwise book an allocation against the wrong brand, and the
 * authorised scope would be unreconstructable from an access log.
 */

const OrgParams = z.object({
  orgId: z.uuid().describe('The organization that owns the funds.'),
});

const CampaignParams = OrgParams.extend({
  campaignId: z.uuid(),
});

/** A per-deposit lot. Funds are never a single pooled number — see the refund rules. */
export const FundingLotSchema = z.object({
  depositId: z.uuid(),
  available: MoneySchema,
  settledAt: z.iso.datetime().nullable().describe('Null while the ACH debit is still clearing.'),
  maturesAt: z
    .iso.datetime()
    .nullable()
    .describe('When this lot leaves its ACH return window and becomes releasable.'),
  fundedAt: z.iso.datetime(),
});

export const OrgFundsSchema = z.object({
  orgId: z.uuid(),
  /** Settled, unallocated, and past its return window. This is what can actually be spent. */
  available: MoneySchema,
  /** Settled but still inside its ACH return window. Visible, not yet releasable. */
  clearing: MoneySchema,
  /** Submitted to the bank, not yet settled. Never allocatable — it lives in a memo account. */
  pending: MoneySchema,
  /** Committed to campaigns and not yet released. */
  allocated: MoneySchema,
  lots: z.array(FundingLotSchema),
});

export const getOrgFunds = defineOperation({
  operationId: 'getOrgFunds',
  method: 'get',
  path: '/v1/orgs/{orgId}/funds',
  summary: 'Read an organization funding balance',
  description:
    'Returns available, clearing, pending and allocated balances plus the per-deposit lots behind ' +
    'them. Pending funds are shown but can never be allocated.',
  tags: ['funding'],
  access: { kind: 'permission', permission: 'funds:read' },
  pathParams: OrgParams,
  successStatus: 200,
  response: OrgFundsSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const CampaignSummarySchema = z.object({
  campaignId: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  state: z.enum(['draft', 'funded', 'live', 'paused', 'completed', 'cancelled']),
  allocated: MoneySchema,
  released: MoneySchema,
  deliverablesTotal: z.int(),
  deliverablesApproved: z.int(),
});

export const listCampaigns = defineOperation({
  operationId: 'listCampaigns',
  method: 'get',
  path: '/v1/orgs/{orgId}/campaigns',
  summary: 'List campaigns in an organization',
  tags: ['campaigns'],
  access: { kind: 'permission', permission: 'campaign:read' },
  pathParams: OrgParams,
  query: z.object({
    workspaceId: z.uuid().optional(),
    state: CampaignSummarySchema.shape.state.optional(),
  }),
  successStatus: 200,
  response: z.object({ campaigns: z.array(CampaignSummarySchema) }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const AllocateBudgetBodySchema = z.object({
  amount: MoneyInputSchema,
  /**
   * DETERMINISTIC, derived from the intent — `allocate:{campaignId}:{campaignVersion}`.
   *
   * It travels in the body as a typed contract field rather than a header, and it is
   * derived rather than random, so a page refresh, a second tab or a React remount
   * produces the identical key. A key held in client memory is destroyed by the refresh
   * that a user reaches for the moment a money action appears to hang — which is exactly
   * when the duplicate would be submitted.
   */
  idempotencyKey: z.string().min(16).max(200),
  /**
   * What the client believed the remaining balance was. An ASSERTION, never an
   * instruction: the server compares it against its own value and refuses on mismatch.
   * No amount a client sends can become an amount the server acts on.
   */
  expectedAvailableMinor: z.string().optional(),
});

export const AllocateBudgetResponseSchema = z.object({
  commandId: z.uuid().describe('The treasury command accepted for processing.'),
  status: z.enum(['accepted']),
  /** Poll or subscribe on this to observe the allocation landing in the ledger. */
  campaignId: z.uuid(),
});

export const allocateBudget = defineOperation({
  operationId: 'allocateBudget',
  method: 'post',
  path: '/v1/orgs/{orgId}/campaigns/{campaignId}/allocations',
  summary: 'Allocate budget from the organization balance to a campaign',
  description:
    'Accepts an allocation intent and returns 202. The API writes a treasury command and enqueues ' +
    'the job in one transaction; it performs no money work inline and holds no Stripe credential. ' +
    'The worker posts the ledger entry, where an over-allocation is rejected by a database ' +
    'constraint rather than by application logic.',
  tags: ['funding'],
  access: {
    kind: 'permission',
    permission: 'campaign:allocate',
    stepUp: false,
    movesMoney: true,
  },
  pathParams: CampaignParams,
  body: AllocateBudgetBodySchema,
  successStatus: 202,
  response: AllocateBudgetResponseSchema,
  errors: [
    'unauthenticated',
    'forbidden',
    'step_up_required',
    'not_found',
    'validation_failed',
    'idempotency_key_reused',
    'insufficient_unallocated_funds',
    'budget_envelope_exceeded',
    'daily_limit_exceeded',
    'organization_frozen',
    'conflict',
  ],
});

export const FUNDING_OPERATIONS = [getOrgFunds, listCampaigns, allocateBudget] as const;
