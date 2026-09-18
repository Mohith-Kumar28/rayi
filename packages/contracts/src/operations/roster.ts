import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The brand's creator roster — the CRM surface.
 *
 * **A creator is a counterparty, not a tenant member.** They have no `Member`
 * row, no role and no permissions in this organization, and modelling them as a
 * member would give them standing in an organization whose money they can see
 * part of. What this surface lists is "creators we have deals with", derived
 * from the deals themselves.
 *
 * Everything here is scoped to THIS organization. A brand sees what a creator
 * has done for them and nothing about the creator's other brands — the roster
 * is not a window into a competitor's spend, and a creator's earnings elsewhere
 * are not a brand's business.
 */

const OrgParams = z.object({ orgId: z.uuid() });
const CreatorParams = OrgParams.extend({ creatorId: z.uuid() });

export const RosterCreatorSchema = z.object({
  creatorId: z.uuid(),
  handle: z.string(),
  displayName: z.string().nullable(),
  /**
   * Whether the creator can currently be PAID.
   *
   * Distinct from whether they have an account. A creator can accept a deal and
   * do the work before Stripe onboarding completes; the money then waits rather
   * than failing, and this is the flag that tells a brand why.
   */
  payoutsEnabled: z.boolean(),
  /**
   * Held because a payout destination changed recently.
   *
   * A 72-hour hold on a newly linked or changed bank account, notified to the
   * OLD contact details. US carriers reassign numbers in about 45 days, so a
   * dormant creator's number is a standing risk and the hold is what makes a
   * SIM swap recoverable rather than final.
   */
  payoutHoldUntil: z.iso.datetime().nullable(),
  dealCount: z.int(),
  activeDealCount: z.int(),
  /** What this organization has actually paid them. Never anything merely approved. */
  totalReleased: MoneySchema,
  /** Agreed on live deals and not yet unlocked. */
  totalCommitted: MoneySchema,
  deliverablesApproved: z.int(),
  /**
   * Approved / submitted, as basis points. Integer — no float touches a ratio
   * that gets displayed next to money.
   */
  approvalRateBps: z.int().min(0).max(10_000).nullable(),
  firstDealAt: z.iso.datetime().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
});

export const listRoster = defineOperation({
  operationId: 'listRoster',
  method: 'get',
  path: '/v1/orgs/{orgId}/creators',
  summary: 'Creators this organization works with',
  description:
    'Derived from deals, not from a membership table — a creator is a counterparty and has no ' +
    'standing in the organization. Scoped to this organization only.',
  tags: ['roster'],
  access: { kind: 'permission', permission: 'creator:read' },
  pathParams: OrgParams,
  query: z.object({
    campaignId: z.uuid().optional(),
    search: z.string().max(80).optional(),
  }),
  successStatus: 200,
  response: z.object({
    creators: z.array(RosterCreatorSchema),
    totals: z.object({ creatorCount: z.int(), released: MoneySchema }),
  }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const RosterCreatorDetailSchema = RosterCreatorSchema.extend({
  bio: z.string().nullable(),
  deals: z.array(
    z.object({
      dealId: z.uuid(),
      campaignName: z.string(),
      state: z.enum([
        'draft',
        'offered',
        'accepted',
        'active',
        'completed',
        'cancelled',
        'terminated',
      ]),
      total: MoneySchema,
      released: MoneySchema,
      createdAt: z.iso.datetime(),
    }),
  ),
});

export const getRosterCreator = defineOperation({
  operationId: 'getRosterCreator',
  method: 'get',
  path: '/v1/orgs/{orgId}/creators/{creatorId}',
  summary: 'One creator, as this brand sees them',
  tags: ['roster'],
  access: { kind: 'permission', permission: 'creator:read' },
  pathParams: CreatorParams,
  successStatus: 200,
  response: RosterCreatorDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const ROSTER_OPERATIONS = [listRoster, getRosterCreator] as const;
