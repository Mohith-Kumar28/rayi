import { z } from 'zod';

import { defineOperation } from '../operation.js';

/**
 * Membership operations.
 *
 * These replace Better Auth's `/organization/*` endpoints, which are blocked at
 * the mount. Its middleware serves and returns BEFORE Nest's guard chain, so
 * `/organization/invite-member` and `/organization/update-member-role` had no
 * MFA, no step-up, no audit row and no coverage from any route test.
 *
 * That is the concrete escalation the security review found: an org admin
 * invites a mailbox they control at a money-bearing role, and nothing in the
 * control design ever sees it.
 */

const OrgParams = z.object({
  orgId: z.uuid().describe('The organization. Scope comes from the URL, never the session.'),
});

const MemberParams = OrgParams.extend({ memberId: z.uuid() });

/**
 * The org roles. COARSE on purpose.
 *
 * Money capability is never one of these — it is a `MoneyAuthority` row.
 * Better Auth stores roles comma-separated, so `MONEY_ROLES.has(role)` is false
 * for `'member,finance'`, and an admin can invite someone at any role they like.
 * Keeping money out of the role string deletes that escalation class rather than
 * patching the four places it could be exploited.
 */
export const OrgRoleSchema = z.enum(['owner', 'admin', 'member']);

export const MemberSchema = z.object({
  memberId: z.uuid(),
  userId: z.string(),
  email: z.email(),
  role: OrgRoleSchema,
  createdAt: z.iso.datetime(),
  /** Whether this member holds any unrevoked money capability. Never a role. */
  hasMoneyAuthority: z.boolean(),
});

export const listMembers = defineOperation({
  operationId: 'listMembers',
  method: 'get',
  path: '/v1/orgs/{orgId}/members',
  summary: 'List the people in an organization',
  tags: ['members'],
  access: { kind: 'permission', permission: 'member:read' },
  pathParams: OrgParams,
  successStatus: 200,
  response: z.object({ members: z.array(MemberSchema) }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const InviteMemberBodySchema = z.object({
  email: z.email().max(255),
  role: OrgRoleSchema,
});

export const inviteMember = defineOperation({
  operationId: 'inviteMember',
  method: 'post',
  path: '/v1/orgs/{orgId}/members',
  summary: 'Invite someone to an organization',
  description:
    'Writes an audit row and never grants money capability. An invitation can only ever produce a ' +
    'ROLE; being trusted with funds is a separate grant that this endpoint cannot make.',
  tags: ['members'],
  access: { kind: 'permission', permission: 'member:invite' },
  pathParams: OrgParams,
  body: InviteMemberBodySchema,
  successStatus: 201,
  response: z.object({ invitationId: z.uuid(), status: z.enum(['pending']) }),
  errors: ['unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'conflict'],
});

export const ChangeMemberRoleBodySchema = z.object({
  role: OrgRoleSchema,
  /** A code from the actor's authenticator app. Role changes are privilege changes. */
  code: z.string().min(6).max(12),
});

export const changeMemberRole = defineOperation({
  operationId: 'changeMemberRole',
  method: 'patch',
  path: '/v1/orgs/{orgId}/members/{memberId}',
  summary: "Change a member's role",
  description:
    'Needs step-up bound to THIS member and THIS role, so a confirmation shown for one change ' +
    'cannot authorise another. Downgrading also revokes the member\u2019s sessions and money ' +
    'authority: a role taken away that leaves a live session is a role still held.',
  tags: ['members'],
  access: { kind: 'permission', permission: 'member:update', stepUp: true },
  pathParams: MemberParams,
  body: ChangeMemberRoleBodySchema,
  successStatus: 200,
  response: z.object({ memberId: z.uuid(), role: OrgRoleSchema }),
  errors: [
    'unauthenticated',
    'forbidden',
    'not_found',
    'validation_failed',
    'conflict',
    'step_up_required',
  ],
});

export const RemoveMemberBodySchema = z.object({
  code: z.string().min(6).max(12),
});

export const removeMember = defineOperation({
  operationId: 'removeMember',
  method: 'post',
  path: '/v1/orgs/{orgId}/members/{memberId}/remove',
  summary: 'Remove someone from an organization',
  description:
    'POST rather than DELETE because it carries a step-up code in the body, and a DELETE with a ' +
    'body is not reliably transported. Revokes sessions and money authority in the same ' +
    'transaction.',
  tags: ['members'],
  access: { kind: 'permission', permission: 'member:remove', stepUp: true },
  pathParams: MemberParams,
  body: RemoveMemberBodySchema,
  successStatus: 200,
  response: z.object({ removed: z.boolean() }),
  errors: [
    'unauthenticated',
    'forbidden',
    'not_found',
    'validation_failed',
    'conflict',
    'step_up_required',
  ],
});

export const MEMBER_OPERATIONS = [
  listMembers,
  inviteMember,
  changeMemberRole,
  removeMember,
] as const;
