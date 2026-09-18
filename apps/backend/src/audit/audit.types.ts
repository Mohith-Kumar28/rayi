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

  // Workspaces and budgets. A ceiling is an authorization decision, so who
  // raised it and when is exactly what an audit is asked for.
  WorkspaceCreated: 'workspace.created',
  WorkspaceUpdated: 'workspace.updated',
  WorkspaceMemberAdded: 'workspace.member_added',
  WorkspaceMemberRemoved: 'workspace.member_removed',
  BudgetEnvelopeApproved: 'budget_envelope.approved',

  // Campaigns and deals
  CampaignCreated: 'campaign.created',
  CampaignUpdated: 'campaign.updated',
  DealCreated: 'deal.created',
  DealOffered: 'deal.offered',
  DealTerminated: 'deal.terminated',

  // Organization
  OrganizationUpdated: 'organization.updated',
  InvitationRevoked: 'invitation.revoked',

  // Creator money. Binding a payout destination is a money action, not a
  // setting, and is logged as one.
  PayoutDestinationChangeStarted: 'payout_destination.change_started',

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

/**
 * What each audited action says to the person it happened to.
 *
 * Server-owned, and complete by construction: the `Record<AuditAction, string>`
 * type means adding an action without writing its sentence fails the build,
 * rather than shipping a screen that shows `member.role_changed` to somebody
 * being asked whether they recognise it.
 *
 * That panel's whole purpose is a person noticing something they did not do —
 * "If something here was not you, sign out everywhere and tell us". A raw event
 * key cannot be evaluated by the one person able to raise the alarm, so the
 * copy is a security property of this log rather than presentation on top of it.
 *
 * Written in the passive, deliberately. The reader is not always the actor —
 * an owner reads their own history, and "Someone's role was changed" is true
 * whoever did it, where "You changed someone's role" would sometimes be a lie
 * on the exact event they are checking.
 */
export const AUDIT_ACTION_COPY: Record<AuditAction, string> = {
  [AuditAction.SessionRevoked]: 'A device was signed out',
  [AuditAction.SessionsRevokedAll]: 'All other devices were signed out',

  [AuditAction.ProfileUpdated]: 'Your profile was updated',
  [AuditAction.EmailChangeRequested]: 'An email address change was requested',
  [AuditAction.EmailChanged]: 'Your email address was changed',
  [AuditAction.EmailChangeCancelled]: 'An email address change was cancelled',
  [AuditAction.TwoFactorEnabled]: 'An authenticator app was added',
  [AuditAction.StepUpFailed]: 'A security code was entered incorrectly',
  [AuditAction.StepUpGranted]: 'A security check was passed',
  [AuditAction.TwoFactorDisabled]: 'An authenticator app was removed',

  [AuditAction.MoneyAuthorityGranted]: 'Permission to move money was granted',
  [AuditAction.MoneyAuthorityRevoked]: 'Permission to move money was removed',
  [AuditAction.MoneyAuthorityDenied]: 'An attempt to move money was refused',

  [AuditAction.BudgetAllocationRequested]: 'Campaign budget was allocated',
  [AuditAction.BudgetAllocationPosted]: 'A campaign budget allocation completed',
  [AuditAction.BudgetAllocationFailed]: 'A campaign budget allocation failed',

  [AuditAction.EmailSuppressed]: 'Email to your address started bouncing',
  [AuditAction.EmailSuppressionLifted]: 'Email to your address resumed',

  [AuditAction.DeliverableApproved]: 'A video was approved',
  [AuditAction.DeliverableApprovalUndone]: 'A video approval was undone',
  [AuditAction.DeliverableChangesRequested]: 'Changes were requested on a video',
  [AuditAction.DeliverableSubmitted]: 'A video was submitted',
  [AuditAction.MilestoneSatisfied]: 'A payment milestone was met',

  [AuditAction.WorkspaceCreated]: 'A workspace was created',
  [AuditAction.WorkspaceUpdated]: 'A workspace was renamed',
  [AuditAction.WorkspaceMemberAdded]: 'Someone was given access to a workspace',
  [AuditAction.WorkspaceMemberRemoved]: 'Someone lost access to a workspace',
  [AuditAction.BudgetEnvelopeApproved]: 'A workspace spending ceiling was approved',

  [AuditAction.CampaignCreated]: 'A campaign was created',
  [AuditAction.CampaignUpdated]: 'A campaign was updated',
  [AuditAction.DealCreated]: 'A deal was drafted',
  [AuditAction.DealOffered]: 'A deal was offered to a creator',
  [AuditAction.DealTerminated]: 'A deal was ended early',

  [AuditAction.OrganizationUpdated]: 'The organization was updated',
  [AuditAction.InvitationRevoked]: 'An invitation was revoked',

  [AuditAction.PayoutDestinationChangeStarted]: 'A payout destination change was started',

  [AuditAction.MemberInvited]: 'Someone was invited to the team',
  [AuditAction.MemberRoleChanged]: "Someone's role was changed",
  [AuditAction.MemberRemoved]: 'Someone was removed from the team',
};

/**
 * The sentence for an action, or the raw key.
 *
 * Falls back rather than throwing: this is the security-activity screen, and an
 * unrecognised key — from an older row, or an action added and not yet
 * described — must still be SHOWN. Hiding an event nobody wrote copy for is
 * exactly backwards on the one screen whose job is showing a person everything
 * that happened to their account.
 */
export function auditActionCopy(action: string): string {
  return AUDIT_ACTION_COPY[action as AuditAction] ?? action;
}
