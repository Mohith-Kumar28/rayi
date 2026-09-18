import { z } from 'zod';

import { defineOperation } from '../operation.js';

/**
 * Account operations — a signed-in user acting on themselves.
 *
 * These exist because the equivalent Better Auth endpoints are blocked at the
 * mount. Better Auth's middleware serves and returns before Nest's guard chain
 * runs, so those endpoints have no audit row, no rate limit of ours, and no
 * place to add step-up later. Blocking them without replacing them would leave a
 * user unable to evict a stolen session, which is the opposite of a security
 * improvement.
 *
 * No `{orgId}`: the resource IS the caller. `access.kind: 'self'` says so
 * explicitly rather than inventing a tenant scope that does not exist.
 */

export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Best-effort, from the request that created the session. */
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /**
   * The session making this request. The UI must distinguish it, so "sign out
   * everywhere else" cannot be confused with signing yourself out mid-task.
   */
  current: z.boolean(),
});

export const listMySessions = defineOperation({
  operationId: 'listMySessions',
  method: 'get',
  path: '/v1/me/sessions',
  summary: 'List your own active sessions',
  description:
    'Returns every unexpired session for the signed-in user. Session tokens are never included — ' +
    'a list that returned them would turn "show me my devices" into "hand me a credential for each".',
  tags: ['account'],
  access: { kind: 'self' },
  successStatus: 200,
  response: z.object({ sessions: z.array(SessionSummarySchema) }),
  errors: ['unauthenticated'],
});

export const revokeMySession = defineOperation({
  operationId: 'revokeMySession',
  method: 'delete',
  path: '/v1/me/sessions/{sessionId}',
  summary: 'Revoke one of your own sessions',
  description:
    'Returns 404 for a session that is not yours, so the endpoint does not confirm which session ' +
    'ids exist.',
  tags: ['account'],
  access: { kind: 'self' },
  pathParams: z.object({ sessionId: z.string().min(1) }),
  successStatus: 204,
  response: z.object({}),
  errors: ['unauthenticated', 'not_found'],
});

export const revokeMyOtherSessions = defineOperation({
  operationId: 'revokeMyOtherSessions',
  method: 'post',
  path: '/v1/me/sessions/revoke-others',
  summary: 'Sign out everywhere except here',
  description:
    'The "I think I have been compromised" action. Deliberately keeps the current session alive: ' +
    'signing a user out of the device they are using, at the moment they are securing their ' +
    'account, forces them back through the same email an attacker may control.',
  tags: ['account'],
  access: { kind: 'self' },
  successStatus: 200,
  response: z.object({ revoked: z.int() }),
  errors: ['unauthenticated'],
});

export const UpdateProfileBodySchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  bio: z.string().max(2000).optional(),
  image: z.url().max(2000).optional(),
});

export const updateMyProfile = defineOperation({
  operationId: 'updateMyProfile',
  method: 'patch',
  path: '/v1/me/profile',
  summary: 'Update your own profile',
  description:
    'An explicit allowlist of fields. Better Auth’s /update-user accepts a partial user object, ' +
    'which is how `role`, `twoFactorEnabled` or `isEmailVerified` become writable by anyone ' +
    'holding a session. Email is not here: changing the address that receives magic links is an ' +
    'account-takeover primitive and needs its own flow.',
  tags: ['account'],
  access: { kind: 'self' },
  body: UpdateProfileBodySchema,
  successStatus: 200,
  response: z.object({ updated: z.boolean() }),
  errors: ['unauthenticated', 'validation_failed', 'forbidden'],
});

export const AuditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.iso.datetime(),
  /** The machine key — what an alert matches on and an investigator greps for. */
  action: z.string(),
  /**
   * The same event as a sentence — "Someone's role was changed".
   *
   * Server-supplied. This screen asks a person whether they recognise what
   * happened to their account, and `member.role_changed` is not a question
   * anybody can answer — so the copy is part of the control, not decoration on
   * top of it.
   */
  label: z.string(),
  ipAddress: z.string().nullable(),
});

export const listMyActivity = defineOperation({
  operationId: 'listMyActivity',
  method: 'get',
  path: '/v1/me/activity',
  summary: 'Your own security activity',
  description:
    'The audit events this user caused. Showing them is what makes the audit log useful to the ' +
    'person most likely to notice something wrong first.',
  tags: ['account'],
  access: { kind: 'self' },
  successStatus: 200,
  response: z.object({ events: z.array(AuditEventSchema) }),
  errors: ['unauthenticated'],
});



// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

export const STEP_UP_PURPOSES = [
  'account:change_email',
  'account:disable_two_factor',
  'account:enable_two_factor',
  'member:change_role',
  'member:remove',
  'money_authority:grant',
  'funds:release',
] as const;

export const StartStepUpBodySchema = z.object({
  purpose: z.enum(STEP_UP_PURPOSES),
  /** The six-digit code from the authenticator app. */
  code: z.string().regex(/^\s*\d{3}\s*\d{3}\s*$|^\d{6}$/, 'Enter the six-digit code.'),
  /**
   * Binds the grant to the exact thing being confirmed — computed by the SERVER
   * from the request that follows, never sent by the client.
   *
   * It is absent from this schema on purpose. A client-supplied binding is not a
   * binding: whoever sends it chooses what the grant covers.
   */
});

export const startStepUp = defineOperation({
  operationId: 'startStepUp',
  method: 'post',
  path: '/v1/me/step-up',
  summary: 'Confirm your identity before a sensitive action',
  description:
    'Verifies a code from your authenticator app and mints a short-lived, single-use grant bound ' +
    'to one purpose. A session cannot prove who is at the keyboard right now — it was established ' +
    'once, possibly days ago, possibly on a device that is no longer in your hands.',
  tags: ['account'],
  access: { kind: 'self' },
  body: StartStepUpBodySchema,
  successStatus: 200,
  response: z.object({ expiresAt: z.iso.datetime() }),
  errors: ['unauthenticated', 'forbidden', 'validation_failed', 'step_up_required'],
});

// ---------------------------------------------------------------------------
// Email change
// ---------------------------------------------------------------------------

export const RequestEmailChangeBodySchema = z.object({
  newEmail: z.email().max(255),
  /** Required. Changing the address that receives magic links is account takeover. */
  code: z.string().min(6).max(12),
});

export const requestEmailChange = defineOperation({
  operationId: 'requestEmailChange',
  method: 'post',
  path: '/v1/me/email',
  summary: 'Start changing your email address',
  description:
    'Needs a fresh authenticator code, and notifies the OLD address. The address that receives ' +
    'magic links IS the account, so changing it is the highest-value takeover step available — ' +
    'and the person who must hear about it is whoever holds the address today.',
  tags: ['account'],
  access: { kind: 'self', stepUp: true },
  body: RequestEmailChangeBodySchema,
  successStatus: 202,
  response: z.object({ status: z.enum(['pending_confirmation']) }),
  errors: ['unauthenticated', 'forbidden', 'validation_failed', 'conflict', 'step_up_required'],
});

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

export const DisableTwoFactorBodySchema = z.object({
  code: z.string().min(6).max(12),
});

export const disableTwoFactor = defineOperation({
  operationId: 'disableTwoFactor',
  method: 'post',
  path: '/v1/me/two-factor/disable',
  summary: 'Remove your authenticator app',
  description:
    'Needs a code from the factor being removed, so possession of the session alone is not ' +
    'enough. Better Auth exposes this with nothing but a session cookie, which is why its version ' +
    'is blocked at the mount.',
  tags: ['account'],
  access: { kind: 'self', stepUp: true },
  body: DisableTwoFactorBodySchema,
  successStatus: 200,
  response: z.object({ twoFactorEnabled: z.boolean() }),
  errors: ['unauthenticated', 'forbidden', 'validation_failed', 'step_up_required'],
});

export const BeginTwoFactorEnrolmentBodySchema = z.object({
  /**
   * A code from the CURRENT factor. Required only when one already exists —
   * swapping a factor is exactly as sensitive as removing one, so an attacker
   * with a session must not be able to enrol their own.
   */
  currentCode: z.string().min(6).max(12).optional(),
});

export const beginTwoFactorEnrolment = defineOperation({
  operationId: 'beginTwoFactorEnrolment',
  method: 'post',
  path: '/v1/me/two-factor/enrol',
  summary: 'Start setting up an authenticator app',
  description:
    'Returns a secret and an otpauth:// URI to render as a QR code. The factor is NOT live yet — ' +
    'it becomes live only once a code from it is confirmed, so a mis-scanned secret or a wrong ' +
    'phone clock cannot lock you out of your own account.',
  tags: ['account'],
  access: { kind: 'self' },
  body: BeginTwoFactorEnrolmentBodySchema,
  successStatus: 200,
  response: z.object({
    secret: z.string().describe('Base32, for manual entry when a QR code cannot be scanned.'),
    otpauthUri: z.string().describe('Render as a QR code. Never log this — it contains the secret.'),
    expiresAt: z.iso.datetime(),
  }),
  errors: ['unauthenticated', 'forbidden', 'validation_failed'],
});

export const ConfirmTwoFactorEnrolmentBodySchema = z.object({
  code: z.string().min(6).max(12),
});

export const confirmTwoFactorEnrolment = defineOperation({
  operationId: 'confirmTwoFactorEnrolment',
  method: 'post',
  path: '/v1/me/two-factor/confirm',
  summary: 'Confirm your authenticator app works',
  description:
    'Proves the secret was transcribed correctly and the clocks agree. Returns recovery codes, ' +
    'shown ONCE — this is the only moment we can show them, and a user who loses their phone with ' +
    'no recovery path has lost the account.',
  tags: ['account'],
  access: { kind: 'self' },
  body: ConfirmTwoFactorEnrolmentBodySchema,
  successStatus: 200,
  response: z.object({
    backupCodes: z.array(z.string()).describe('Shown once. Never retrievable again.'),
  }),
  errors: ['unauthenticated', 'forbidden', 'validation_failed'],
});

export const ACCOUNT_SECURITY_OPERATIONS = [
  startStepUp,
  requestEmailChange,
  beginTwoFactorEnrolment,
  confirmTwoFactorEnrolment,
  disableTwoFactor,
] as const;

export const ACCOUNT_OPERATIONS = [
  listMySessions,
  revokeMySession,
  revokeMyOtherSessions,
  updateMyProfile,
  listMyActivity,
  ...ACCOUNT_SECURITY_OPERATIONS,
] as const;
