import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  useGetOrgFunds,
  useListCampaigns,
  useAllocateBudget,
  ApiError,
} from '@rayi/api-client';

import { Money, formatMoney, type MoneyValue } from '../components/Money';
import { allocationIdempotencyKey, toMinorUnits } from '../lib/allocation';

/**
 * The first vertical slice: allocate budget from the organization balance to a
 * campaign.
 *
 * `orgId` comes from the ROUTE, never from an ambient `activeOrganizationId` on
 * the session. That field is shared mutable state across tabs — an agency
 * operator with two clients open would otherwise book an allocation against the
 * wrong brand, and the authorised scope would be unreconstructable from a log.
 */

function StatCard({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: MoneyValue;
  tone: 'secured' | 'clearing' | 'pending' | 'neutral';
  note: string;
}) {
  const dot = {
    secured: 'bg-secured',
    clearing: 'bg-clearing',
    pending: 'bg-pending',
    neutral: 'bg-muted',
  }[tone];

  return (
    <div className="rounded-xl border border-hair bg-white p-5">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
        <span className="text-sm font-medium text-muted">{label}</span>
      </div>
      <div className="mt-2">
        <Money value={value} size="lg" className="text-ink" />
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function FundsScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/funds' });

  const funds = useGetOrgFunds(orgId);
  const campaigns = useListCampaigns(orgId);
  const allocate = useAllocateBudget();

  const [campaignId, setCampaignId] = useState('');
  const [amountMajor, setAmountMajor] = useState('');
  const [result, setResult] = useState<string | null>(null);

  const problem = allocate.error instanceof ApiError ? allocate.error.problem : null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setResult(null);

    // Major units -> minor units, as a string. Returns null rather than guessing
    // at anything it cannot convert exactly, so a stray character or a third
    // decimal place stops here instead of becoming a confidently wrong amount.
    const minorUnits = toMinorUnits(amountMajor);

    const campaign = campaigns.data?.campaigns.find((row) => row.campaignId === campaignId);
    const available = funds.data?.available.amountMinor;

    // All three come from what this screen actually rendered. If any is missing
    // the screen is not in a state where an amount could have been chosen.
    if (minorUnits === null || !campaign || available === undefined) {
      setResult(null);
      return;
    }

    allocate.mutate(
      {
        orgId,
        campaignId,
        data: {
          amount: { amountMinor: minorUnits, currency: 'USD' },
          // Names the INTENT, not the attempt: identical across a refresh,
          // different once the first allocation has landed. See lib/allocation.ts.
          idempotencyKey: allocationIdempotencyKey({
            campaignId,
            allocatedMinor: campaign.allocated.amountMinor,
            amountMinor: minorUnits,
          }),
          /*
           * What this screen was showing when the amount was chosen. The server
           * compares it against its own figure and refuses on mismatch — because
           * "allocate $8,000 of the $10,000 I can see" is not the same decision
           * once a colleague has spent $7,000 of it, even though $8,000 still
           * fits. Never an instruction: no number sent from here can become a
           * number the server acts on.
           */
          expectedAvailableMinor: available,
        },
      },
      {
        onSuccess: (accepted) =>
          setResult(`Accepted — command ${accepted.commandId.slice(0, 8)}…`),
      },
    );
  }

  if (funds.isPending) {
    return <p className="p-8 text-sm text-muted">Loading funds…</p>;
  }

  if (funds.isError) {
    return <p className="p-8 text-sm text-red-700">Could not load funds.</p>;
  }

  const data = funds.data;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Campaign funds</h1>
        <p className="mt-1 text-sm text-muted">
          Money sits with our payment partner until a milestone is verified. It is never held by Rayi.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Available to allocate"
          value={data.available}
          tone="secured"
          note="Settled and past its return window."
        />
        <StatCard
          label="Clearing"
          value={data.clearing}
          tone="clearing"
          note="Settled, still inside the bank return window."
        />
        <StatCard
          label="Processing"
          value={data.pending}
          tone="pending"
          note="With the bank. Cannot be allocated yet."
        />
        <StatCard
          label="Allocated"
          value={data.allocated}
          tone="neutral"
          note="Committed to campaigns, not yet released."
        />
      </div>

      <section className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
        <div>
          <h2 className="text-sm font-semibold text-ink">Campaigns</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-hair bg-white">
            {campaigns.isPending ? (
              <p className="p-4 text-sm text-muted">Loading…</p>
            ) : campaigns.data && campaigns.data.campaigns.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5 font-medium">Campaign</th>
                    <th className="px-4 py-2.5 font-medium">Approved</th>
                    <th className="px-4 py-2.5 text-right font-medium">Allocated</th>
                    <th className="px-4 py-2.5 text-right font-medium">Released</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.data.campaigns.map((campaign) => (
                    <tr key={campaign.campaignId} className="border-b border-hair/60 last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{campaign.name}</div>
                        <div className="text-xs text-muted">{campaign.state}</div>
                      </td>
                      <td className="px-4 py-3 text-muted tabular-nums">
                        {campaign.deliverablesApproved}/{campaign.deliverablesTotal}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money value={campaign.allocated} size="sm" className="text-ink" />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Money value={campaign.released} size="sm" className="text-muted" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-ink">No campaigns yet</p>
                <p className="mt-1 text-sm text-muted">
                  Your {formatMoney(data.available)} is ready to put to work.
                </p>
              </div>
            )}
          </div>
        </div>

        <form onSubmit={submit} className="h-fit rounded-xl border border-hair bg-white p-5">
          <h2 className="text-sm font-semibold text-ink">Allocate budget</h2>

          <label className="mt-4 block">
            <span className="text-xs font-medium text-muted">Campaign</span>
            <select
              required
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink"
            >
              <option value="">Select…</option>
              {campaigns.data?.campaigns.map((campaign) => (
                <option key={campaign.campaignId} value={campaign.campaignId}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-3 block">
            <span className="text-xs font-medium text-muted">Amount (USD)</span>
            <input
              required
              inputMode="decimal"
              pattern="^\d+(\.\d{1,2})?$"
              placeholder="25000.00"
              value={amountMajor}
              onChange={(event) => setAmountMajor(event.target.value)}
              className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 text-sm tabular-nums text-ink"
            />
          </label>

          <button
            type="submit"
            disabled={allocate.isPending || !campaignId || !amountMajor}
            className="mt-4 w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {allocate.isPending ? 'Allocating…' : 'Allocate'}
          </button>

          {problem && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
            >
              <p className="font-medium text-amber-900">{problem.title}</p>
              {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
              <p className="mt-2 font-mono text-[11px] text-amber-700">{problem.code}</p>
            </div>
          )}

          {result && (
            <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              {result}
            </p>
          )}
        </form>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-semibold text-ink">Deposits</h2>
        <p className="mt-1 text-xs text-muted">
          Funds are tracked per deposit, so a refund always returns to the account it came from.
        </p>
        <ul className="mt-3 divide-y divide-hair overflow-hidden rounded-xl border border-hair bg-white">
          {data.lots.map((lot) => (
            <li key={lot.depositId} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-mono text-xs text-muted">{lot.depositId.slice(0, 8)}…</div>
                <div className="mt-0.5 text-xs text-muted">
                  {lot.settledAt === null
                    ? 'Processing with the bank'
                    : lot.maturesAt && new Date(lot.maturesAt) > new Date()
                      ? `Clearing until ${new Date(lot.maturesAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}`
                      : 'Available'}
                </div>
              </div>
              <Money value={lot.available} size="base" className="text-ink" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
