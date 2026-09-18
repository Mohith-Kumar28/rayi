import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import {
  ApiError,
  useCreateCampaign,
  useListCampaigns,
  useListWorkspaces,
} from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
import {
  Card,
  Empty,
  Field,
  LoadFailed,
  Loading,
  Page,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components/Shell';
import { CAMPAIGN_STATE, StatusPill } from '../components/StatusPill';

/**
 * Campaigns.
 *
 * A campaign draws its budget directly from the ORGANIZATION balance — there is
 * no workspace budget in the ledger. The workspace matters here for a different
 * reason: its envelope is the authorization ceiling this campaign's allocations
 * will be checked against, so choosing one is choosing whose approved budget
 * you are spending.
 *
 * Creating a campaign moves no money. Allocating does, and it is a separate
 * action on a separate screen — which is why the create form below has no
 * amount field at all.
 */

function ProgressBar({ approved, total }: { approved: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-hair">
        <div className="h-full rounded-full bg-secured" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted">
        {approved}/{total}
      </span>
    </div>
  );
}

function NewCampaignForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const workspaces = useListWorkspaces(orgId);
  const create = useCreateCampaign();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');

  const problem = create.error instanceof ApiError ? create.error.problem : null;
  const chosen = workspaces.data?.workspaces.find((row) => row.workspaceId === workspaceId);

  return (
    <Card
      title="New campaign"
      description="Creating a campaign moves no money. Allocating a budget to it is a separate action."
    >
      <div className="space-y-3">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Skincare — Q4 launch"
          />
        </Field>

        <Field
          label="Workspace"
          hint="Allocations to this campaign draw down that workspace's approved ceiling."
        >
          <select
            className={inputClass}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">Select…</option>
            {workspaces.data?.workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.name}
              </option>
            ))}
          </select>
        </Field>

        {/*
          Said at the point of choosing, not discovered at the point of
          allocating. A workspace with no envelope cannot fund anything, and
          finding that out after building a campaign is a wasted afternoon.
        */}
        {chosen && !chosen.envelope && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <strong>{chosen.name}</strong> has no approved budget yet, so you will not be able to
            allocate anything to this campaign until finance approves one.
          </p>
        )}
        {chosen?.envelope && BigInt(chosen.envelope.remaining.amountMinor) === 0n && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            <strong>{chosen.name}</strong> has used its whole approved budget. Deals already running
            are unaffected, but you cannot allocate anything new until finance raises the ceiling.
          </p>
        )}

        <Field label="Brief" hint="Optional. Creators see this on the offer.">
          <textarea
            className={inputClass}
            rows={3}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
        </Field>

        {problem && (
          <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">{problem.title}</p>
            {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={create.isPending || !name.trim() || !workspaceId}
            className={primaryButtonClass}
            onClick={() =>
              create.mutate(
                {
                  orgId,
                  data: {
                    workspaceId,
                    name: name.trim(),
                    brief: brief.trim() || null,
                    startsAt: null,
                    endsAt: null,
                  },
                },
                { onSuccess: onDone },
              )
            }
          >
            {create.isPending ? 'Creating…' : 'Create campaign'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

export function CampaignsScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/campaigns' });
  const campaigns = useListCampaigns(orgId);
  const [creating, setCreating] = useState(false);

  if (campaigns.isPending) return <Loading what="campaigns" />;
  if (campaigns.isError) return <LoadFailed what="campaigns" />;

  const rows = campaigns.data.campaigns;

  return (
    <Page
      title="Campaigns"
      subtitle="A campaign holds a budget drawn from your organization balance and groups the deals paid out of it."
      actions={
        !creating && (
          <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
            New campaign
          </button>
        )
      }
    >
      {creating && (
        <div className="mb-4">
          <NewCampaignForm orgId={orgId} onDone={() => setCreating(false)} />
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          title="No campaigns yet"
          hint="A campaign is where a budget and a group of creators meet. Create one, allocate funds to it, then offer deals."
          action={
            <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
              New campaign
            </button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-hair bg-white">
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
              {rows.map((campaign) => (
                <tr key={campaign.campaignId} className="border-b border-hair/60 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      to="/o/$orgId/campaigns/$campaignId"
                      params={{ orgId, campaignId: campaign.campaignId }}
                      className="flex items-center gap-2"
                    >
                      <span className="font-medium text-ink">{campaign.name}</span>
                      <StatusPill value={campaign.state} vocabulary={CAMPAIGN_STATE} />
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar
                      approved={campaign.deliverablesApproved}
                      total={campaign.deliverablesTotal}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Money value={campaign.allocated as MoneyValue} className="text-ink" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {/* Released is money that has ACTUALLY moved. It sits beside
                        allocated deliberately, because the gap between them is
                        the only honest picture of a campaign's spend. */}
                    <Money value={campaign.released as MoneyValue} className="text-secured" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
