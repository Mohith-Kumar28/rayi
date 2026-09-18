import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * Campaigns.
 *
 * A campaign is allocated a budget directly from the ORGANIZATION balance —
 * there is no workspace budget layer in the ledger. Finance approves the funding
 * envelope and sets the ceiling; marketing then allocates freely beneath it
 * without per-campaign approval.
 *
 * `listCampaigns` and `allocateBudget` live in `funding.ts`, with the money.
 * What is here is the campaign as an OBJECT rather than as a budget line.
 */

const OrgParams = z.object({ orgId: z.uuid() });
const CampaignParams = OrgParams.extend({ campaignId: z.uuid() });

export const CampaignStateSchema = z.enum(['draft', 'live', 'paused', 'closed']);

export const CreateCampaignBodySchema = z.object({
  workspaceId: z.uuid(),
  name: z.string().min(1).max(160),
  brief: z.string().max(4000).nullable(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
});

export const CampaignDetailSchema = z.object({
  campaignId: z.uuid(),
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  name: z.string(),
  brief: z.string().nullable(),
  state: CampaignStateSchema,
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),

  /** Drawn from the organization balance and held against this campaign. */
  allocated: MoneySchema,
  /** Committed to offered or accepted deals. Cannot exceed `allocated`. */
  committed: MoneySchema,
  /** Money that has actually moved to creators. */
  released: MoneySchema,
  /**
   * `allocated - committed`. Server-computed.
   *
   * The browser never subtracts money: a client that does arithmetic on money
   * is a client that can disagree with the ledger.
   */
  uncommitted: MoneySchema,

  dealCount: z.int(),
  deliverablesTotal: z.int(),
  deliverablesApproved: z.int(),
});

export const createCampaign = defineOperation({
  operationId: 'createCampaign',
  method: 'post',
  path: '/v1/orgs/{orgId}/campaigns',
  summary: 'Create a campaign',
  description: 'Creates it in draft with no budget. Allocating is a separate, money-moving action.',
  tags: ['campaigns'],
  access: { kind: 'permission', permission: 'campaign:create' },
  pathParams: OrgParams,
  body: CreateCampaignBodySchema,
  successStatus: 201,
  response: CampaignDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const getCampaign = defineOperation({
  operationId: 'getCampaign',
  method: 'get',
  path: '/v1/orgs/{orgId}/campaigns/{campaignId}',
  summary: 'One campaign',
  tags: ['campaigns'],
  access: { kind: 'permission', permission: 'campaign:read' },
  pathParams: CampaignParams,
  successStatus: 200,
  response: CampaignDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const UpdateCampaignBodySchema = z.object({
  name: z.string().min(1).max(160).optional(),
  brief: z.string().max(4000).nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  state: CampaignStateSchema.optional(),
});

export const updateCampaign = defineOperation({
  operationId: 'updateCampaign',
  method: 'patch',
  path: '/v1/orgs/{orgId}/campaigns/{campaignId}',
  summary: 'Update a campaign',
  description:
    'Pausing stops new deals being offered. It does NOT pause deals already accepted — a creator ' +
    'mid-way through agreed work does not lose their milestone because a campaign was paused.',
  tags: ['campaigns'],
  access: { kind: 'permission', permission: 'campaign:update' },
  pathParams: CampaignParams,
  body: UpdateCampaignBodySchema,
  successStatus: 200,
  response: CampaignDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const CAMPAIGN_OPERATIONS = [createCampaign, getCampaign, updateCampaign] as const;
