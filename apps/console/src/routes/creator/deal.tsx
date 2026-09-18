import { Link, useParams } from '@tanstack/react-router';
import { ApiError, useGetMyDeal, useSubmitDeliverable } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';

/**
 * One deal, from the creator's side.
 *
 * The screen answers two questions in order: **what do I still have to do**, and
 * **what does that unlock**. Everything is arranged around that, because a
 * creator opens this between takes and closes it again in under a minute.
 */

const STATE_COPY: Record<string, { label: string; tone: string; note: string }> = {
  pending: { label: 'Not started', tone: 'bg-muted/10 text-muted', note: 'Upload when you are ready.' },
  submitted: { label: 'Sent', tone: 'bg-clearing/10 text-clearing', note: 'Waiting to be looked at.' },
  in_review: {
    label: 'Being reviewed',
    tone: 'bg-clearing/10 text-clearing',
    note: 'The brand is looking at this.',
  },
  changes_requested: {
    label: 'Changes asked',
    tone: 'bg-pending/10 text-pending',
    note: 'Read the note and send a new version.',
  },
  approved: { label: 'Approved', tone: 'bg-secured/10 text-secured', note: 'Done.' },
  cancelled: { label: 'Cancelled', tone: 'bg-muted/10 text-muted', note: 'No longer needed.' },
};

export function CreatorDealScreen() {
  const { dealId } = useParams({ from: '/me/deals/$dealId' });
  const deal = useGetMyDeal(dealId);
  const submit = useSubmitDeliverable();

  if (deal.isPending) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (deal.isError) return <p className="p-6 text-sm text-red-700">Could not load this deal.</p>;

  const problem = submit.error instanceof ApiError ? submit.error.problem : null;
  const todo = deal.data.deliverables.filter((row) =>
    ['pending', 'changes_requested'].includes(row.state),
  );

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <header className="mb-6">
        {/*
          A way back. Without it this screen is a dead end on a phone — the
          creator's only exit is the browser's own back gesture, and there is no
          brand chrome above to return them to their work.
        */}
        <Link to="/me" className="text-sm text-muted">
          ← Your work
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">
          {deal.data.brandName}
        </h1>
        <p className="mt-0.5 text-sm text-muted">{deal.data.campaignName}</p>

        <div className="mt-4 flex items-baseline gap-6 rounded-xl border border-hair bg-white p-4">
          <div>
            <div className="text-[11px] font-medium text-muted">Deal worth</div>
            <Money value={deal.data.total as MoneyValue} size="base" className="text-ink" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-muted">Released so far</div>
            {/* Money that has ACTUALLY moved. Never anything merely approved —
                the release job may not have run, and it may yet fail. */}
            <Money value={deal.data.earned as MoneyValue} size="base" className="text-secured" />
          </div>
        </div>
      </header>

      {deal.data.nextUnlock && (
        <section className="mb-6 rounded-xl border border-hair bg-white p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
            Your next payment
          </h2>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink">{deal.data.nextUnlock.title}</span>
            <Money
              value={deal.data.nextUnlock.amount as MoneyValue}
              size="base"
              className="text-ink"
            />
          </div>
          {/* The engine's sentence, verbatim. */}
          <p className="mt-2 text-sm leading-relaxed text-muted">{deal.data.nextUnlock.reason}</p>
        </section>
      )}

      {todo.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {todo.length === 1 ? 'One thing to do' : `${todo.length} things to do`}
          </h2>
          <ul className="space-y-3">
            {todo.map((row) => (
              <li key={row.deliverableId} className="rounded-xl border border-hair bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-ink">{row.slot}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      STATE_COPY[row.state]?.tone ?? ''
                    }`}
                  >
                    {STATE_COPY[row.state]?.label ?? row.state}
                  </span>
                </div>

                {row.brief && <p className="mt-2 text-sm text-muted">{row.brief}</p>}

                {row.latestComment && (
                  // What the brand actually said. Shown in full rather than
                  // truncated: this is the entire instruction for the next
                  // attempt, and a creator who has to tap to read it will not.
                  <div className="mt-3 rounded-lg bg-canvas p-3">
                    <div className="text-[11px] font-medium text-muted">The brand said</div>
                    <p className="mt-1 text-sm leading-relaxed text-ink">{row.latestComment}</p>
                  </div>
                )}

                <button
                  type="button"
                  disabled={submit.isPending}
                  onClick={() => {
                    // Upload goes DIRECT to S3 with a presigned POST and a
                    // server-chosen key, and completion is learned from the S3
                    // event rather than from the client. This button stands in
                    // for that flow until the media pipeline lands — it is
                    // wired to the real submit endpoint, with a placeholder key.
                    submit.mutate({
                      deliverableId: row.deliverableId,
                      data: { assetKey: `pending-upload/${row.deliverableId}` },
                    });
                  }}
                  className="mt-3 w-full rounded-lg bg-ink px-3 py-2.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  {row.state === 'changes_requested' ? 'Send a new version' : 'Upload'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {problem && (
        <div role="alert" className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">{problem.title}</p>
          {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">Payment schedule</h2>
        <ul className="divide-y divide-hair overflow-hidden rounded-xl border border-hair bg-white">
          {deal.data.milestones.map((milestone) => (
            <li key={milestone.milestoneId} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink">{milestone.title}</span>
                <div className="flex items-center gap-2">
                  <Money value={milestone.amount as MoneyValue} size="sm" className="text-ink" />
                  {milestone.releasedAt ? (
                    <span className="rounded-full bg-secured/10 px-2 py-0.5 text-[11px] font-medium text-secured">
                      Released
                    </span>
                  ) : milestone.satisfied ? (
                    // Unlocked but not yet moved. Saying "paid" here would be
                    // the product asserting something that has not happened.
                    <span className="rounded-full bg-clearing/10 px-2 py-0.5 text-[11px] font-medium text-clearing">
                      Unlocked
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted/10 px-2 py-0.5 text-[11px] font-medium text-muted">
                      Locked
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{milestone.reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">All videos</h2>
        <ul className="divide-y divide-hair overflow-hidden rounded-xl border border-hair bg-white">
          {deal.data.deliverables.map((row) => (
            <li
              key={row.deliverableId}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <span className="text-sm text-ink">{row.slot}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  STATE_COPY[row.state]?.tone ?? ''
                }`}
              >
                {STATE_COPY[row.state]?.label ?? row.state}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
