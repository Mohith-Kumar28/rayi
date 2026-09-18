import { z } from 'zod';

import { MoneyInputSchema, MoneySchema } from '../money.js';
import { defineOperation } from '../operation.js';

/**
 * Workspaces — a sub-brand, product line or market.
 *
 * **A workspace holds no money.** It groups campaigns and people, and it owns a
 * `BudgetEnvelope`, which is an AUTHORIZATION CEILING rather than a ledger
 * account. That distinction is the whole design: it reconciles "each workspace
 * has its own budget" with "the ledger stays two levels", because the two
 * sentences are about different objects.
 *
 * Campaigns still allocate directly from the organization balance. The envelope
 * only decides whether a given allocation is ALLOWED, enforced by
 * `CHECK (committedMinor <= ceilingMinor)` plus a conditional update so the
 * draw-down cannot race. No third account level, no new over-allocation
 * invariant to keep true.
 *
 * These are Rayi tables, not Better Auth teams. Better Auth's `teamMember` is
 * `(id, teamId, userId, createdAt)` with **no role column**, and team-scoped
 * permissions were requested and closed as not planned — while a workspace's
 * defining property is having its own finance approver, which an org-wide role
 * cannot express.
 */

const OrgParams = z.object({
  orgId: z.uuid().describe('The organization. Scope comes from the URL, never the session.'),
});

const WorkspaceParams = OrgParams.extend({ workspaceId: z.uuid() });

/**
 * A finance-approved spending ceiling for a workspace.
 *
 * `committed` counts what campaigns in this workspace have drawn down. When it
 * reaches the ceiling, NEW allocations are refused and **already-committed
 * deals keep running** — a creator who accepted a deal never discovers their
 * milestone cannot pay because somebody else exhausted an envelope.
 */
export const BudgetEnvelopeSchema = z.object({
  ceiling: MoneySchema,
  committed: MoneySchema,
  /** `ceiling - committed`. Server-computed so no client ever subtracts money. */
  remaining: MoneySchema,
  /**
   * When this envelope stops authorising new allocations.
   *
   * Null means it does not expire. An expired envelope behaves exactly like an
   * exhausted one: new allocations refused, committed deals unaffected.
   */
  expiresAt: z.iso.datetime().nullable(),
  approvedByEmail: z.email().nullable(),
  approvedAt: z.iso.datetime().nullable(),
});

export const WorkspaceSummarySchema = z.object({
  workspaceId: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
  campaignCount: z.int(),
  memberCount: z.int(),
  /** Null when finance has never approved one. No envelope means no allocations. */
  envelope: BudgetEnvelopeSchema.nullable(),
});

export const listWorkspaces = defineOperation({
  operationId: 'listWorkspaces',
  method: 'get',
  path: '/v1/orgs/{orgId}/workspaces',
  summary: 'The workspaces in an organization',
  description:
    'A workspace groups campaigns and people and holds no money. Its budget envelope is an ' +
    'authorization ceiling, not a ledger account.',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:read' },
  pathParams: OrgParams,
  successStatus: 200,
  response: z.object({ workspaces: z.array(WorkspaceSummarySchema) }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const CreateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(120),
  /**
   * Unique PER ORGANIZATION, not globally.
   *
   * Which is exactly why `WorkspaceMember` carries a composite foreign key on
   * `(workspaceId, organizationId)`: without it, a membership row could link
   * org A's member to org B's identically-slugged workspace.
   */
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, numbers and hyphens.'),
});

export const createWorkspace = defineOperation({
  operationId: 'createWorkspace',
  method: 'post',
  path: '/v1/orgs/{orgId}/workspaces',
  summary: 'Create a workspace',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:create' },
  pathParams: OrgParams,
  body: CreateWorkspaceBodySchema,
  successStatus: 201,
  response: WorkspaceSummarySchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const WorkspaceMemberSchema = z.object({
  memberId: z.uuid(),
  email: z.email(),
  /** The ORGANIZATION role. A workspace does not grant one — it grants access. */
  orgRole: z.enum(['owner', 'admin', 'member']),
  /**
   * Whether this person may approve budget envelopes for this workspace.
   *
   * The reason workspaces are Rayi tables rather than Better Auth teams: a
   * workspace's defining property is having its own finance approver, and an
   * org-wide role string cannot say "approves budgets for the UK market only".
   */
  isFinanceApprover: z.boolean(),
  addedAt: z.iso.datetime(),
});

export const WorkspaceDetailSchema = WorkspaceSummarySchema.extend({
  members: z.array(WorkspaceMemberSchema),
  campaigns: z.array(
    z.object({
      campaignId: z.uuid(),
      name: z.string(),
      state: z.enum(['draft', 'live', 'paused', 'closed']),
      allocated: MoneySchema,
    }),
  ),
});

export const getWorkspace = defineOperation({
  operationId: 'getWorkspace',
  method: 'get',
  path: '/v1/orgs/{orgId}/workspaces/{workspaceId}',
  summary: 'One workspace',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:read' },
  pathParams: WorkspaceParams,
  successStatus: 200,
  response: WorkspaceDetailSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const UpdateWorkspaceBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

export const updateWorkspace = defineOperation({
  operationId: 'updateWorkspace',
  method: 'patch',
  path: '/v1/orgs/{orgId}/workspaces/{workspaceId}',
  summary: 'Rename a workspace',
  description: 'The slug is immutable — it appears in URLs people have bookmarked and shared.',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:update' },
  pathParams: WorkspaceParams,
  body: UpdateWorkspaceBodySchema,
  successStatus: 200,
  response: WorkspaceSummarySchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'validation_failed'],
});

export const SetBudgetEnvelopeBodySchema = z.object({
  ceiling: MoneyInputSchema,
  expiresAt: z.iso.datetime().nullable(),
  /** Step-up code. Raising a spending ceiling is a finance decision, not a click. */
  code: z.string().min(6).max(12),
});

export const setBudgetEnvelope = defineOperation({
  operationId: 'setBudgetEnvelope',
  method: 'put',
  path: '/v1/orgs/{orgId}/workspaces/{workspaceId}/envelope',
  summary: 'Approve a spending ceiling for a workspace',
  description:
    'The ceiling can never be set BELOW what is already committed: that would not claw anything ' +
    'back, it would only make the stored numbers disagree with the deals already running. ' +
    'Lowering a ceiling stops new allocations; it does not touch committed ones.',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'envelope:approve', stepUp: true },
  pathParams: WorkspaceParams,
  body: SetBudgetEnvelopeBodySchema,
  successStatus: 200,
  response: BudgetEnvelopeSchema,
  errors: [
    'unauthenticated',
    'forbidden',
    'step_up_required',
    'not_found',
    'conflict',
    'validation_failed',
  ],
});

export const AddWorkspaceMemberBodySchema = z.object({
  memberId: z.uuid().describe('An existing organization member. This grants access, not membership.'),
  isFinanceApprover: z.boolean(),
});

export const addWorkspaceMember = defineOperation({
  operationId: 'addWorkspaceMember',
  method: 'post',
  path: '/v1/orgs/{orgId}/workspaces/{workspaceId}/members',
  summary: 'Give an organization member access to a workspace',
  description:
    'Takes an existing `memberId` rather than an email. A workspace cannot create a member — that ' +
    'is what makes "must already be in this organization" a foreign key rather than a check ' +
    'somebody can forget.',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:update' },
  pathParams: WorkspaceParams,
  body: AddWorkspaceMemberBodySchema,
  successStatus: 201,
  response: WorkspaceMemberSchema,
  errors: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'validation_failed'],
});

export const removeWorkspaceMember = defineOperation({
  operationId: 'removeWorkspaceMember',
  method: 'delete',
  path: '/v1/orgs/{orgId}/workspaces/{workspaceId}/members/{memberId}',
  summary: 'Remove someone from a workspace',
  tags: ['workspaces'],
  access: { kind: 'permission', permission: 'workspace:update' },
  pathParams: WorkspaceParams.extend({ memberId: z.uuid() }),
  successStatus: 200,
  response: z.object({ removed: z.boolean() }),
  errors: ['unauthenticated', 'forbidden', 'not_found'],
});

export const WORKSPACE_OPERATIONS = [
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  setBudgetEnvelope,
  addWorkspaceMember,
  removeWorkspaceMember,
] as const;
