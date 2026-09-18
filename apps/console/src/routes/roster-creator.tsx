import { Link, useParams } from '@tanstack/react-router';
import { useGetRosterCreator } from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
import { Card, LoadFailed, Loading, Page } from '../components/Shell';
import { DEAL_STATE, StatusPill } from '../components/StatusPill';

/**
 * One creator, as this brand sees them.
 *
 * Scoped to this organization. What they earn elsewhere, who else they work
 * with and how they are doing on other campaigns are not a brand's business,
 * and the absence of those figures here is the design rather than an omission.
 */
export function RosterCreatorScreen() {
  const { orgId, creatorId } = useParams({ from: '/o/$orgId/creators/$creatorId' });
  const creator = useGetRosterCreator(orgId, creatorId);

  if (creator.isPending) return <Loading what="this creator" />;
  if (creator.isError) return <LoadFailed what="this creator" />;

  const data = creator.data;
  const held = data.payoutHoldUntil && new Date(data.payoutHoldUntil) > new Date();

  return (
    <Page
      title={data.handle}
      width="narrow"
      subtitle={
        <>
          {data.displayName && <>{data.displayName} · </>}
          <Link to="/o/$orgId/creators" params={{ orgId }} className="underline">
            all creators
          </Link>
        </>
      }
    >
      {/*
        The payout state comes first, because it is the only thing on this page
        a brand can act on — everything else is history. A creator who cannot be
        paid has money sitting still, and that is a conversation to have now.
      */}
      {!data.payoutsEnabled && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            {data.handle} cannot receive money yet
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            They can still accept deals and do the work — anything they earn waits for them rather
            than failing. It arrives once they finish setting up their payout details.
          </p>
        </div>
      )}
      {data.payoutsEnabled && held && (
        <div className="mb-4 rounded-xl border border-hair bg-white p-4">
          <p className="text-sm font-medium text-ink">Payouts paused until{' '}
            {new Date(data.payoutHoldUntil!).toLocaleDateString('en-US', {
              day: 'numeric',
              month: 'short',
            })}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Their bank details changed recently. Every change pauses payouts for 72 hours and
            notifies their previous contact details, so a hijacked account cannot quietly redirect
            someone's income.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-hair bg-white p-4">
          <div className="text-xs font-medium text-muted">Paid to them</div>
          <div className="mt-1">
            <Money value={data.totalReleased as MoneyValue} size="lg" className="text-secured" />
          </div>
        </div>
        <div className="rounded-xl border border-hair bg-white p-4">
          <div className="text-xs font-medium text-muted">Committed</div>
          <div className="mt-1">
            <Money value={data.totalCommitted as MoneyValue} size="lg" className="text-ink" />
          </div>
        </div>
        <div className="rounded-xl border border-hair bg-white p-4">
          <div className="text-xs font-medium text-muted">Videos approved</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">
            {data.deliverablesApproved}
          </div>
        </div>
      </div>

      {data.bio && (
        <Card className="mt-4" title="About">
          <p className="text-sm leading-relaxed text-ink">{data.bio}</p>
        </Card>
      )}

      <Card className="mt-4 p-0">
        <h2 className="border-b border-hair px-4 py-3 text-sm font-semibold text-ink">
          Deals with you
        </h2>
        <ul className="divide-y divide-hair">
          {data.deals.map((deal) => (
            <li key={deal.dealId}>
              <Link
                to="/o/$orgId/deals/$dealId"
                params={{ orgId, dealId: deal.dealId }}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-ink">{deal.campaignName}</span>
                  <StatusPill value={deal.state} vocabulary={DEAL_STATE} />
                </div>
                <div className="flex shrink-0 items-baseline gap-4">
                  <Money value={deal.released as MoneyValue} className="text-secured" />
                  <span className="text-xs text-muted">of</span>
                  <Money value={deal.total as MoneyValue} className="text-ink" />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}
