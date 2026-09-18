import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useListCampaigns, useListDeals } from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
import {
  Empty,
  LoadFailed,
  Loading,
  Page,
  selectClass,
  primaryButtonClass,
} from '../components/Shell';
import { DEAL_STATE, StatusPill } from '../components/StatusPill';

/**
 * Every deal in the organization.
 *
 * Two figures sit at the top and they are deliberately not one figure:
 * **committed** is what has been promised to creators on live deals, and
 * **released** is what has actually moved. A single "spend" number would have to
 * pick one and would be wrong about the other — and the gap between them is
 * precisely the money a brand still owes but has not paid.
 *
 * Both are computed by the server over the filtered set. The browser never adds
 * money up: a client that does arithmetic on money is a client that can disagree
 * with the ledger, and the disagreement surfaces as a figure somebody screenshots.
 */

const STATES = [
  'draft',
  'offered',
  'accepted',
  'active',
  'completed',
  'cancelled',
  'terminated',
] as const;

export function DealsScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/deals' });
  const [campaignId, setCampaignId] = useState('');
  const [state, setState] = useState('');

  const campaigns = useListCampaigns(orgId);
  const deals = useListDeals(orgId, {
    ...(campaignId ? { campaignId } : {}),
    ...(state ? { state: state as (typeof STATES)[number] } : {}),
  });

  return (
    <Page
      title="Deals"
      subtitle="One deal is one agreement with one creator. Terms, milestones and the payout ceiling are all per-creator, which is why they live here rather than on the campaign."
      actions={
        <Link to="/o/$orgId/deals/new" params={{ orgId }} className={primaryButtonClass}>
          New deal
        </Link>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          aria-label="Campaign"
          className={selectClass}
          value={campaignId}
          onChange={(event) => setCampaignId(event.target.value)}
        >
          <option value="">All campaigns</option>
          {campaigns.data?.campaigns.map((campaign) => (
            <option key={campaign.campaignId} value={campaign.campaignId}>
              {campaign.name}
            </option>
          ))}
        </select>

        <select
          aria-label="State"
          className={selectClass}
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="">Any state</option>
          {STATES.map((value) => (
            <option key={value} value={value}>
              {DEAL_STATE[value]?.label ?? value}
            </option>
          ))}
        </select>
      </div>

      {deals.isPending ? (
        <Loading what="deals" />
      ) : deals.isError ? (
        <LoadFailed what="deals" />
      ) : deals.data.deals.length === 0 ? (
        <Empty
          title="No deals here"
          hint="A deal is an agreement with one creator: what they make, what it pays, and what has to be true before each payment is released."
          action={
            <Link to="/o/$orgId/deals/new" params={{ orgId }} className={primaryButtonClass}>
              New deal
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-hair bg-white p-4">
              <div className="text-xs font-medium text-muted">Committed</div>
              <div className="mt-1">
                <Money
                  value={deals.data.totals.committed as MoneyValue}
                  size="lg"
                  className="text-ink"
                />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                Promised to creators on these deals. Not yet paid.
              </p>
            </div>
            <div className="rounded-xl border border-hair bg-white p-4">
              <div className="text-xs font-medium text-muted">Released</div>
              <div className="mt-1">
                <Money
                  value={deals.data.totals.released as MoneyValue}
                  size="lg"
                  className="text-secured"
                />
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                Money that has actually moved. Never anything merely approved.
              </p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-hair bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Creator</th>
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-4 py-2.5 text-right font-medium">Videos</th>
                  <th className="px-4 py-2.5 text-right font-medium">Worth</th>
                  <th className="px-4 py-2.5 text-right font-medium">Released</th>
                </tr>
              </thead>
              <tbody>
                {deals.data.deals.map((deal) => (
                  <tr key={deal.dealId} className="border-b border-hair/60 last:border-0">
                    <td className="px-4 py-3">
                      <Link
                        to="/o/$orgId/deals/$dealId"
                        params={{ orgId, dealId: deal.dealId }}
                        className="flex items-center gap-2"
                      >
                        <span className="font-medium text-ink">{deal.creatorHandle}</span>
                        <StatusPill value={deal.state} vocabulary={DEAL_STATE} />
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{deal.campaignName}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      {deal.deliverablesApproved}/{deal.deliverablesTotal}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money value={deal.total as MoneyValue} className="text-ink" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Money
                        value={deal.released as MoneyValue}
                        className={
                          BigInt(deal.released.amountMinor) > 0n ? 'text-secured' : 'text-muted'
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
