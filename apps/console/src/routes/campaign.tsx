import { Link, useParams } from '@tanstack/react-router';
import { useGetCampaign, useListDeals } from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
import { Card, Empty, LoadFailed, Loading, Page, primaryButtonClass } from '../components/Shell';
import { CAMPAIGN_STATE, DEAL_STATE, StatusPill } from '../components/StatusPill';

/**
 * One campaign.
 *
 * Four money figures, and they are four rather than one because they answer
 * four different questions: what is **allocated** to this campaign, what is
 * **committed** to deals out of it, what has actually been **released**, and
 * what is still **uncommitted** and therefore spendable. Collapsing any of them
 * into "budget" or "spend" would make one of those questions unanswerable.
 *
 * Every one of them is server-computed. The browser never subtracts money.
 */

function Figure({
  label,
  value,
  note,
  tone = 'ink',
}: {
  label: string;
  value: MoneyValue;
  note: string;
  tone?: 'ink' | 'secured' | 'muted';
}) {
  const colour =
    tone === 'secured' ? 'text-secured' : tone === 'muted' ? 'text-muted' : 'text-ink';
  return (
    <div className="rounded-xl border border-hair bg-white p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1">
        <Money value={value} size="lg" className={colour} />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function CampaignScreen() {
  const { orgId, campaignId } = useParams({ from: '/o/$orgId/campaigns/$campaignId' });
  const campaign = useGetCampaign(orgId, campaignId);
  const deals = useListDeals(orgId, { campaignId });

  if (campaign.isPending) return <Loading what="this campaign" />;
  if (campaign.isError) return <LoadFailed what="this campaign" />;

  const data = campaign.data;

  return (
    <Page
      title={data.name}
      subtitle={
        <>
          <Link
            to="/o/$orgId/workspaces/$workspaceId"
            params={{ orgId, workspaceId: data.workspaceId }}
            className="underline"
          >
            {data.workspaceName}
          </Link>
          {data.brief && <> · {data.brief}</>}
        </>
      }
      actions={
        <>
          <StatusPill value={data.state} vocabulary={CAMPAIGN_STATE} />
          <Link to="/o/$orgId/deals/new" params={{ orgId }} className={primaryButtonClass}>
            New deal
          </Link>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Figure
          label="Allocated"
          value={data.allocated as MoneyValue}
          note="Drawn from your organization balance and held for this campaign."
        />
        <Figure
          label="Committed"
          value={data.committed as MoneyValue}
          note="Promised to creators on offered and accepted deals."
        />
        <Figure
          label="Released"
          value={data.released as MoneyValue}
          tone="secured"
          note="Money that has actually moved."
        />
        <Figure
          label="Uncommitted"
          value={data.uncommitted as MoneyValue}
          tone="muted"
          note="Allocated here and not yet promised to anyone."
        />
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">Deals</h2>
          <p className="text-xs text-muted">
            {data.deliverablesApproved} of {data.deliverablesTotal} videos approved
          </p>
        </div>

        {deals.isPending ? (
          <Loading what="deals" />
        ) : deals.isError ? (
          <LoadFailed what="deals" />
        ) : deals.data.deals.length === 0 ? (
          <Empty
            title="No deals in this campaign yet"
            hint="Offer a deal to a creator and it appears here. Nothing is committed until you send the offer."
            action={
              <Link to="/o/$orgId/deals/new" params={{ orgId }} className={primaryButtonClass}>
                New deal
              </Link>
            }
          />
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-hair">
              {deals.data.deals.map((deal) => (
                <li key={deal.dealId}>
                  <Link
                    to="/o/$orgId/deals/$dealId"
                    params={{ orgId, dealId: deal.dealId }}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {deal.creatorHandle}
                      </span>
                      <StatusPill value={deal.state} vocabulary={DEAL_STATE} />
                    </div>
                    <div className="flex shrink-0 items-baseline gap-6 text-right">
                      <span className="text-xs tabular-nums text-muted">
                        {deal.deliverablesApproved}/{deal.deliverablesTotal}
                      </span>
                      <Money value={deal.total as MoneyValue} className="text-ink" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </Page>
  );
}
