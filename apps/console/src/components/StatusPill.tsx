/**
 * The status vocabulary, in one place.
 *
 * Every state word a user reads comes from here, for the same reason the
 * funding status copy is server-owned: a label written inline at each call site
 * drifts, and the drift shows up as two screens describing the same deal with
 * two different words.
 *
 * The tone mapping is the load-bearing part. `secured` (green) means SETTLED —
 * money that is safe, work that is done. It is never used for something in
 * flight, because a green pill is read as "fine, nothing to do", and the states
 * that need attention are exactly the ones that must not look like that.
 */

export type Tone = 'neutral' | 'progress' | 'done' | 'warn' | 'stop';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-muted/10 text-muted',
  progress: 'bg-clearing/10 text-clearing',
  done: 'bg-secured/10 text-secured',
  warn: 'bg-amber-50 text-amber-800',
  stop: 'bg-red-50 text-red-700',
};

interface Entry {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * Deal states.
 *
 * `offered` is deliberately NOT green. An offer is money committed against the
 * campaign and nothing owed to anybody — reading it as a settled deal is how a
 * brand double-counts what it has spent.
 */
export const DEAL_STATE: Record<string, Entry> = {
  draft: { label: 'Draft', tone: 'neutral' },
  offered: { label: 'Offered', tone: 'progress' },
  accepted: { label: 'Accepted', tone: 'progress' },
  active: { label: 'Active', tone: 'progress' },
  completed: { label: 'Completed', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  terminated: { label: 'Ended early', tone: 'warn' },
};

export const CAMPAIGN_STATE: Record<string, Entry> = {
  draft: { label: 'Draft', tone: 'neutral' },
  live: { label: 'Live', tone: 'progress' },
  paused: { label: 'Paused', tone: 'warn' },
  closed: { label: 'Closed', tone: 'neutral' },
};

/** Written from the CREATOR's side, because they are who reads these most. */
export const DELIVERABLE_STATE: Record<string, Entry> = {
  pending: { label: 'Not started', tone: 'neutral' },
  submitted: { label: 'Sent', tone: 'progress' },
  in_review: { label: 'Being reviewed', tone: 'progress' },
  changes_requested: { label: 'Changes asked', tone: 'warn' },
  approved: { label: 'Approved', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/**
 * Payout states.
 *
 * `paid` is the only green one. `in_transit` is money that has left Rayi and
 * has not arrived, and a creator refreshing their banking app needs those to be
 * different words.
 */
export const PAYOUT_STATE: Record<string, Entry> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  in_transit: { label: 'On its way', tone: 'progress' },
  paid: { label: 'Paid', tone: 'done' },
  failed: { label: 'Failed', tone: 'stop' },
  held: { label: 'Paused', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const COMMAND_STATE: Record<string, Entry> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  claimed: { label: 'Running', tone: 'progress' },
  succeeded: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'stop' },
  abandoned: { label: 'Given up', tone: 'stop' },
};

export const WEBHOOK_STATE: Record<string, Entry> = {
  received: { label: 'Not processed', tone: 'warn' },
  processed: { label: 'Processed', tone: 'done' },
  failed: { label: 'Failed', tone: 'stop' },
  ignored: { label: 'Ignored', tone: 'neutral' },
};

export const INVITATION_STATE: Record<string, Entry> = {
  pending: { label: 'Waiting', tone: 'progress' },
  accepted: { label: 'Accepted', tone: 'done' },
  revoked: { label: 'Revoked', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export function StatusPill({
  value,
  vocabulary,
  className = '',
}: {
  value: string;
  vocabulary: Record<string, Entry>;
  className?: string;
}) {
  // An unmapped state shows the raw key rather than nothing. A missing pill is
  // invisible; a visibly wrong one gets reported.
  const entry = vocabulary[value] ?? { label: value, tone: 'neutral' as const };

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[entry.tone]} ${className}`}
    >
      {entry.label}
    </span>
  );
}
