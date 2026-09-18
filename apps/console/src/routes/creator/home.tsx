import { useGetMyEarnings, useListMyDeals } from '@rayi/api-client';
import { Link } from '@tanstack/react-router';

import { Money, type MoneyValue } from '../../components/Money';

/**
 * The creator's home.
 *
 * A different product from the brand console, for a different person on a
 * different device. Three things follow from that and shape every decision here:
 *
 * **It is a phone.** Single column, large targets, nothing that needs hover.
 * The brand console is a desk tool; this is opened between takes.
 *
 * **It answers one question.** "When do I get paid, and what do I have to do to
 * get paid?" Everything else is secondary to that sentence.
 *
 * **It never overstates money.** Three figures, deliberately distinct — paid
 * out, awaiting payout, agreed but not yet unlocked. Collapsing them into one
 * number tells a creator they have money they cannot spend, and they will plan
 * around it.
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
  tone: 'paid' | 'soon' | 'later';
}) {
  const dot = { paid: 'bg-secured', soon: 'bg-clearing', later: 'bg-muted' }[tone];

  return (
    <div className="rounded-xl border border-hair bg-white p-4">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
        <span className="text-xs font-medium text-muted">{label}</span>
      </div>
      <div className="mt-1.5">
        <Money value={value} size="lg" className="text-ink" />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function CreatorHomeScreen() {
  const earnings = useGetMyEarnings();
  const deals = useListMyDeals();

  if (earnings.isPending || deals.isPending) {
    return <p className="p-6 text-sm text-muted">Loading…</p>;
  }
  if (earnings.isError || deals.isError) {
    return <p className="p-6 text-sm text-red-700">Could not load your deals.</p>;
  }

  const active = deals.data.deals.filter((deal) =>
    ['offered', 'accepted', 'active'].includes(deal.state),
  );

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Your work</h1>
      </header>

      <div className="grid gap-3">
        <Figure
          label="Paid out"
          value={earnings.data.paidOut as MoneyValue}
          tone="paid"
          note="Sent to your bank. This money has left Rayi."
        />
        <Figure
          label="On its way"
          value={earnings.data.awaitingPayout as MoneyValue}
          tone="soon"
          note="Unlocked and waiting for the next payout run."
        />
        <Figure
          label="Not unlocked yet"
          value={earnings.data.agreedNotYetUnlocked as MoneyValue}
          tone="later"
          // Deliberately not called "earned" or "pending". It is what these
          // deals are worth IF the work is approved, and saying anything
          // stronger is a promise the brand has not made.
          note="What these deals are worth once the work is approved."
        />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Your deals</h2>

        {active.length === 0 ? (
          <div className="rounded-xl border border-hair bg-white p-8 text-center">
            <p className="text-sm font-medium text-ink">No deals yet</p>
            <p className="mt-1 text-sm text-muted">
              When a brand offers you one, it appears here with everything already agreed.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {active.map((deal) => (
              <li key={deal.dealId}>
                <Link
                  to="/me/deals/$dealId"
                  params={{ dealId: deal.dealId }}
                  className="block rounded-xl border border-hair bg-white p-4"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink">{deal.brandName}</div>
                      <div className="truncate text-xs text-muted">{deal.campaignName}</div>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-2">
                      <div className="text-right">
                        {/* Labelled. An unlabelled figure beside a brand name
                            reads as "what I am getting paid", and this is the
                            whole deal's worth — most of it not yet unlocked. */}
                        <div className="text-[10px] uppercase tracking-wide text-muted">
                          Deal worth
                        </div>
                        <Money value={deal.total as MoneyValue} size="base" className="text-ink" />
                      </div>
                      {/* The card is a link; it needs to look like one. */}
                      <span aria-hidden className="text-muted">
                        ›
                      </span>
                    </div>
                  </div>

                  {deal.nextUnlock && (
                    // THE most useful line on the screen. The engine's own
                    // sentence, produced by the function that decides whether
                    // money moves — so this can never promise what the engine
                    // will not do.
                    <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-ink">
                      {deal.nextUnlock.reason}
                    </p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
