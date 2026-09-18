import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useListRoster } from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
import { Empty, LoadFailed, Loading, Page, inputClass } from '../components/Shell';

/**
 * The creator roster.
 *
 * **A creator is a counterparty, not a member of this organization.** They have
 * no role and no permissions here, and this list is derived from the deals
 * themselves rather than from a membership table — which is also why it shows
 * nothing about a creator's work for anyone else. A brand's roster is not a
 * window into a competitor's spend.
 *
 * The most useful column is not money: it is whether the creator can actually
 * BE PAID. A creator with a disabled or held payout destination is somebody
 * whose money is sitting still, and the brand finding that out here is much
 * better than finding out when the creator emails asking where it is.
 */

function PayoutState({
  enabled,
  holdUntil,
}: {
  enabled: boolean;
  holdUntil: string | null;
}) {
  if (!enabled) {
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
        Cannot be paid yet
      </span>
    );
  }
  if (holdUntil && new Date(holdUntil) > new Date()) {
    return (
      <span className="rounded-full bg-clearing/10 px-2 py-0.5 text-[11px] font-medium text-clearing">
        Paused until{' '}
        {new Date(holdUntil).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
      </span>
    );
  }
  return <span className="text-[11px] text-muted">Ready</span>;
}

export function RosterScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/creators' });
  const [search, setSearch] = useState('');
  const roster = useListRoster(orgId, search ? { search } : {});

  return (
    <Page
      title="Creators"
      subtitle="Everyone you have a deal with. A creator is a counterparty rather than a member of your organization, so this is built from your deals — and shows nothing about their work for anyone else."
    >
      <input
        aria-label="Search creators"
        className={`${inputClass} mt-0 mb-4 max-w-sm`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by handle or name"
      />

      {roster.isPending ? (
        <Loading what="creators" />
      ) : roster.isError ? (
        <LoadFailed what="creators" />
      ) : roster.data.creators.length === 0 ? (
        <Empty
          title={search ? 'Nobody matches that' : 'No creators yet'}
          hint={
            search
              ? 'Try a different handle or name.'
              : 'Creators appear here once you offer them a deal. They do not need a Rayi account first.'
          }
        />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">
            {roster.data.totals.creatorCount}{' '}
            {roster.data.totals.creatorCount === 1 ? 'creator' : 'creators'} ·{' '}
            <Money value={roster.data.totals.released as MoneyValue} className="text-ink" /> paid
            out in total
          </p>

          <div className="overflow-hidden rounded-xl border border-hair bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Creator</th>
                  <th className="px-4 py-2.5 font-medium">Payouts</th>
                  <th className="px-4 py-2.5 text-right font-medium">Deals</th>
                  <th className="px-4 py-2.5 text-right font-medium">Approved</th>
                  <th className="px-4 py-2.5 text-right font-medium">Paid</th>
                </tr>
              </thead>
              <tbody>
                {roster.data.creators.map((creator) => (
                  <tr key={creator.creatorId} className="border-b border-hair/60 last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        to="/o/$orgId/creators/$creatorId"
                        params={{ orgId, creatorId: creator.creatorId }}
                      >
                        <div className="font-medium text-ink">{creator.handle}</div>
                        {creator.displayName && (
                          <div className="text-xs text-muted">{creator.displayName}</div>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <PayoutState
                        enabled={creator.payoutsEnabled}
                        holdUntil={creator.payoutHoldUntil}
                      />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      {creator.activeDealCount} of {creator.dealCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      {creator.deliverablesApproved}
                      {creator.approvalRateBps != null && (
                        <span className="ml-1 text-[11px]">
                          ({Math.round(creator.approvalRateBps / 100)}%)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money
                        value={creator.totalReleased as MoneyValue}
                        className={
                          BigInt(creator.totalReleased.amountMinor) > 0n
                            ? 'text-secured'
                            : 'text-muted'
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
