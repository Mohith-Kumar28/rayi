import { z } from 'zod';

import { MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * The organization itself, and its pending invitations.
 *
 * **Vocabulary matters here for a legal reason, not a stylistic one.** What a
 * brand funds is not a wallet: the money sits at Stripe, the balance is an
 * earmark in Rayi's ledger, and unallocated funds are refundable to the
 * ORIGINATING bank account — not withdrawable to an arbitrary destination and
 * never transferable between organizations. The customer-facing words are
 * campaign funds, secured, available to allocate, payment protection.
 *
 * Invitations live here rather than in `members.ts` because a pending
 * invitation is not a member. Treating it as one is how a list of "people"
 * silently includes mailboxes nobody has accepted from.
 */

const OrgParams = z.object({ orgId: z.uuid() });

export const OrganizationSchema = z.object({
  organizationId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
  /**
   * Whether outbound money movement is halted for this organization.
   *
   * Frozen is OUTBOUND ONLY and never blocks ingestion — freezing the clearing
   * account would kill webhook processing during an incident and burn the
   * provider's retry window, turning a contained problem into a silent one.
   */
  frozen: z.boolean(),
  /**
   * The per-organization daily release ceiling, in force when no genuine second
   * approver exists.
   *
   * Applies on risk signals rather than on self-declared headcount: a ceiling a
   * second account removes would punish honesty, since a founder who declares
   * solo mode gets a cap while an attacker with two mailboxes gets none.
   */
  dailyReleaseCeiling: MoneySchema,
  /** How much of today's ceiling is already used. Resets on the org's own day boundary. */
  dailyReleased: MoneySchema,
  /** Last four of the funding bank account, when one is linked. Never more than four. */
  bankAccountLast4: z.string().length(4).nullable(),
  bankAccountStatus: z.enum(['none', 'pending_verification', 'verified', 'blocked']),
});

export const getOrganization = defineOperation({
  operationId: 'getOrganization',
  method: 'get',
  path: '/v1/orgs/{orgId}',
  summary: 'The organization',
  tags: ['organization'],
  access: { kind: 'permission', permission: 'org:read' },
  pathParams: OrgParams,
  successStatus: 200,
  response: OrganizationSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const UpdateOrganizationBodySchema = z.object({
  name: z.string().min(1).max(160).optional(),
  /** Step-up. Renaming a brand changes what creators see on every offer. */
  code: z.string().min(6).max(12),
});

export const updateOrganization = defineOperation({
  operationId: 'updateOrganization',
  method: 'patch',
  path: '/v1/orgs/{orgId}',
  summary: 'Update the organization',
  description:
    'The slug is immutable. It appears in URLs, in invitations already sent, and in the public ' +
    'creator-facing pages — changing it silently breaks links other people hold.',
  tags: ['organization'],
  access: { kind: 'permission', permission: 'org:update', stepUp: true },
  pathParams: OrgParams,
  body: UpdateOrganizationBodySchema,
  successStatus: 200,
  response: OrganizationSchema,
  errors: [
    'unauthenticated',
    'forbidden',
    'step_up_required',
    'not_found',
    'validation_failed',
  ],
});

export const InvitationSchema = z.object({
  invitationId: z.uuid(),
  email: z.email(),
  role: z.enum(['owner', 'admin', 'member']),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  invitedByEmail: z.email(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const listInvitations = defineOperation({
  operationId: 'listInvitations',
  method: 'get',
  path: '/v1/orgs/{orgId}/invitations',
  summary: 'Invitations that have not been accepted',
  description:
    'A pending invitation is an unclaimed route into this organization, so it belongs on a screen ' +
    'somebody looks at — not only in the mailbox it was sent to.',
  tags: ['organization'],
  access: { kind: 'permission', permission: 'member:read' },
  pathParams: OrgParams,
  successStatus: 200,
  response: z.object({ invitations: z.array(InvitationSchema) }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const revokeInvitation = defineOperation({
  operationId: 'revokeInvitation',
  method: 'post',
  path: '/v1/orgs/{orgId}/invitations/{invitationId}/revoke',
  summary: 'Revoke an invitation',
  description:
    'Revoking is a state change, not a delete. The row stays, because "who was invited and by ' +
    'whom, and who cancelled it" is exactly the history an investigation needs.',
  tags: ['organization'],
  access: { kind: 'permission', permission: 'member:invite' },
  pathParams: OrgParams.extend({ invitationId: z.uuid() }),
  successStatus: 200,
  response: z.object({ revoked: z.boolean() }),
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict'],
});

export const ORGANIZATION_OPERATIONS = [
  getOrganization,
  updateOrganization,
  listInvitations,
  revokeInvitation,
] as const;
