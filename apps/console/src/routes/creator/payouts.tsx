import { Link } from '@tanstack/react-router';
import { useGetMyPayoutDestination, useGetMyPayouts } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';
import { PAYOUT_STATE, StatusPill } from '../../components/StatusPill';

/**
 * The creator's payouts.
 *
 * Every word on this screen is written for somebody who may be checking whether
 * they can pay rent. Three rules follow from that:
 *
 * **Never promise a day.** Arrival is an estimate from the payment provider and
 * is labelled as one. "Paid out Friday. Always." is a sentence the product
 * cannot keep, and the one time it is wrong is the time it matters most.
 *
 * **A pause says why, and what to do.** A held payout with a status code is a
 * support ticket; a held payout that explains a bank-details change and offers
 * the stop link is a person who can act.
 *
 * **Nothing here is called "earned" unless it moved.** Scheduled money is
 * scheduled money.
 */

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: MoneyValue;
  note: string;
  tone: string;
}) {
  return (
    <div className="rounded-xl border border-hair bg-white p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1">
        <Money value={value} size="lg" className={tone} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function CreatorPayoutsScreen() {
  const payouts = useGetMyPayouts();
  const destination = useGetMyPayoutDestination();

  if (payouts.isPending) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (payouts.isError)
    return <p className="p-6 text-sm text-red-700">Could not load your payouts.</p>;

  const held =
    destination.data?.holdUntil && new Date(destination.data.holdUntil) > new Date()
      ? destination.data.holdUntil
      : null;

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <header className="mb-6">
        <Link to="/me" className="text-sm text-muted">
          ← Your work
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">Your money</h1>
      </header>

      {/*
        The destination state comes before the list, because a creator whose
        payouts cannot land needs to know that before they read a list of
        payouts that are not landing.
      */}
      {destination.data && !destination.data.payoutsEnabled && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            We cannot send you money yet
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            Your work still counts and anything you earn is waiting for you — it is not lost. Finish
            setting up your payout details and it arrives on the next run.
          </p>
          {destination.data.pendingRequirements.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
              {destination.data.pendingRequirements.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          )}
          <Link
            to="/me/profile"
            className="mt-3 inline-block rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white"
          >
            Finish setup
          </Link>
        </div>
      )}

      {held && (
        <div className="mb-4 rounded-xl border border-hair bg-white p-4">
          <p className="text-sm font-medium text-ink">
            Payouts are paused until{' '}
            {new Date(held).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Your bank details changed on{' '}
            {destination.data?.lastChangedAt
              ? new Date(destination.data.lastChangedAt).toLocaleDateString('en-US', {
                  day: 'numeric',
                  month: 'short',
                })
              : 'a recent date'}
            . Every change pauses payouts for 72 hours. <strong>If that was not you</strong>, use the
            stop link in the email we sent to your previous address — it undoes the change.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <Figure
          // Not "On its way" — that is what the vocabulary calls `in_transit`,
          // and this money has not been sent yet. The summary must not contradict
          // the pill on the row it is summarising.
          label="Next payout"
          value={payouts.data.awaitingNextRun as MoneyValue}
          tone="text-ink"
          note={
            payouts.data.nextRunAt
              ? `Unlocked and waiting for the next payout run, expected around ${new Date(
                  payouts.data.nextRunAt,
                ).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}.`
              : 'Unlocked and waiting for the next payout run.'
          }
        />
      </div>

      {destination.data?.last4 && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-hair bg-white px-4 py-3">
          <div className="text-sm text-ink">
            {destination.data.bankName ?? 'Your bank'} ····{destination.data.last4}
          </div>
          <Link to="/me/profile" className="text-sm text-muted underline">
            Change
          </Link>
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-ink">Every payout</h2>

      {payouts.data.payouts.length === 0 ? (
        <div className="rounded-xl border border-hair bg-white p-8 text-center">
          <p className="text-sm font-medium text-ink">Nothing yet</p>
          <p className="mt-1 text-sm text-muted">
            Your first payout appears here once a milestone unlocks.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {payouts.data.payouts.map((payout) => (
            <li key={payout.payoutId} className="rounded-xl border border-hair bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Money
                    value={payout.amount as MoneyValue}
                    size="lg"
                    precision="exact"
                    className={payout.state === 'paid' ? 'text-secured' : 'text-ink'}
                  />
                  <div className="mt-0.5 text-xs text-muted">
                    {payout.paidAt ? (
                      <>
                        Arrived{' '}
                        {new Date(payout.paidAt).toLocaleDateString('en-US', {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </>
                    ) : payout.expectedArrivalAt ? (
                      // An estimate, said as one.
                      <>
                        Expected around{' '}
                        {new Date(payout.expectedArrivalAt).toLocaleDateString('en-US', {
                          day: 'numeric',
                          month: 'short',
                        })}{' '}
                        — banks vary by a day or two
                      </>
                    ) : (
                      'No arrival date yet'
                    )}
                  </div>
                </div>
                <StatusPill value={payout.state} vocabulary={PAYOUT_STATE} />
              </div>

              {payout.reason && (
                <p className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink">
                  {payout.reason}
                </p>
              )}

              <ul className="mt-3 space-y-1">
                {payout.sources.map((source, index) => (
                  <li
                    key={`${source.dealId}-${index}`}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-muted">
                      {source.brandName} · {source.milestoneTitle}
                    </span>
                    <Money value={source.amount as MoneyValue} className="text-muted" />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
