/**
 * The audited actions, enumerated.
 *
 * Not free text. An action name is what an alert matches on and what an
 * investigator greps for, so a typo is an event that no alert will ever fire for
 * and no search will ever find — silently, and only discovered when someone
 * needs it most.
 *
 * Adding one is a deliberate edit that a reviewer sees.
 */
export const AuditAction = {
  // Sessions
  SessionRevoked: 'session.revoked',
  SessionsRevokedAll: 'session.revoked_all',

  // Account
  ProfileUpdated: 'account.profile_updated',
  EmailChangeRequested: 'account.email_change_requested',
  EmailChanged: 'account.email_changed',
  EmailChangeCancelled: 'account.email_change_cancelled',
  TwoFactorEnabled: 'account.two_factor_enabled',
  /// Counted for rate limiting, so the count and the history cannot disagree.
  StepUpFailed: 'account.step_up_failed',
  StepUpGranted: 'account.step_up_granted',
  TwoFactorDisabled: 'account.two_factor_disabled',

  // Money capability. The reason this log exists at all.
  MoneyAuthorityGranted: 'money_authority.granted',
  MoneyAuthorityRevoked: 'money_authority.revoked',
  MoneyAuthorityDenied: 'money_authority.denied',

  // Treasury
  BudgetAllocationRequested: 'treasury.allocation_requested',
  BudgetAllocationPosted: 'treasury.allocation_posted',
  BudgetAllocationFailed: 'treasury.allocation_failed',

  // Email deliverability. A suppressed address is a user who can no longer sign
  // in, so "why did mail stop" has to be answerable when they contact support.
  EmailSuppressed: 'email.suppressed',
  EmailSuppressionLifted: 'email.suppression_lifted',

  // The review queue. Approving a deliverable can deterministically release
  // funds, so these are money events even though no ledger entry is written here.
  DeliverableApproved: 'deliverable.approved',
  DeliverableApprovalUndone: 'deliverable.approval_undone',
  DeliverableChangesRequested: 'deliverable.changes_requested',
  DeliverableSubmitted: 'deliverable.submitted',
  MilestoneSatisfied: 'milestone.satisfied',

  // Membership
  MemberInvited: 'member.invited',
  MemberRoleChanged: 'member.role_changed',
  MemberRemoved: 'member.removed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEventInput {
  readonly action: AuditAction;
  readonly actorUserId?: string | null;
  readonly actorMemberId?: string | null;
  readonly organizationId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /**
   * Structured detail. Never a rendered sentence — a message is written once for
   * whoever reads it today, whereas fields are queried by whoever investigates
   * in two years.
   *
   * Must not contain secrets, tokens or full PII. What changed, not the value it
   * changed to, unless the value is itself the point.
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly seq: bigint;
  readonly occurredAt: Date;
  readonly action: string;
  readonly actorUserId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly ipAddress: string | null;
  readonly data: Record<string, unknown>;
}

export interface ChainBreak {
  readonly seq: bigint;
  readonly reason: string;
}

export interface AuditHead {
  readonly seq: bigint;
  /** Hex-encoded SHA-256. Publish this off-account to make truncation detectable. */
  readonly hash: string;
  readonly occurredAt: Date;
}
