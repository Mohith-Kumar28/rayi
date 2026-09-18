import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ApiError, useGetWorkspace, useSetBudgetEnvelope } from '@rayi/api-client';

import { Money, formatMoney, type MoneyValue } from '../components/Money';
import {
  Card,
  Field,
  LoadFailed,
  Loading,
  Page,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components/Shell';
import { CAMPAIGN_STATE, StatusPill } from '../components/StatusPill';
import { formatDay } from '../lib/dates';
import { toMinorUnits } from '../lib/allocation';

/**
 * One workspace, and its approved ceiling.
 *
 * Setting a ceiling is a finance decision and is gated by step-up, which is why
 * the form below asks for a code. It is NOT a money movement — nothing leaves
 * and nothing arrives — it changes what future allocations are permitted to do.
 * The copy distinguishes those two things carefully, because a screen that
 * makes approving a budget feel like spending it is a screen where approving
 * gets avoided.
 */

function EnvelopeForm({
  orgId,
  workspaceId,
  committed,
  onDone,
}: {
  orgId: string;
  workspaceId: string;
  committed: MoneyValue;
  onDone: () => void;
}) {
  const set = useSetBudgetEnvelope();
  const [amount, setAmount] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [code, setCode] = useState('');

  const minor = toMinorUnits(amount, 2);
  const committedMinor = BigInt(committed.amountMinor);
  // A ceiling below what is already committed claws nothing back; it would only
  // make the stored numbers disagree with the deals already running. The server
  // refuses it, and the form says so before anyone submits.
  const belowCommitted = minor !== null && BigInt(minor) < committedMinor;
  const problem = set.error instanceof ApiError ? set.error.problem : null;

  return (
    <Card
      title="Approve a ceiling"
      description="This decides how much this workspace may commit to deals. It moves no money."
    >
      <div className="space-y-3">
        <Field
          label="Ceiling (USD)"
          hint={`Already committed: ${formatMoney(committed, 'exact')}`}
        >
          <input
            className={inputClass}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="150000.00"
          />
        </Field>

        {belowCommitted && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
            That is below what this workspace has already committed. Lowering a ceiling stops new
            deals being offered; it cannot take back money already promised to a creator.
          </p>
        )}

        <Field label="Expires" hint="Optional. An expired ceiling stops new deals, like a used-up one.">
          <input
            type="date"
            className={inputClass}
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </Field>

        <Field label="Your authenticator code">
          <input
            className={inputClass}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            placeholder="000000"
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
            className={primaryButtonClass}
            disabled={set.isPending || minor === null || belowCommitted || code.length !== 6}
            onClick={() =>
              set.mutate(
                {
                  orgId,
                  workspaceId,
                  data: {
                    ceiling: { amountMinor: minor!, currency: 'USD' },
                    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                    code,
                  },
                },
                { onSuccess: onDone },
              )
            }
          >
            {set.isPending ? 'Approving…' : 'Approve ceiling'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

export function WorkspaceScreen() {
  const { orgId, workspaceId } = useParams({ from: '/o/$orgId/workspaces/$workspaceId' });
  const workspace = useGetWorkspace(orgId, workspaceId);
  const [editing, setEditing] = useState(false);

  if (workspace.isPending) return <Loading what="this workspace" />;
  if (workspace.isError) return <LoadFailed what="this workspace" />;

  const data = workspace.data;
  const envelope = data.envelope;

  return (
    <Page
      title={data.name}
      subtitle={
        <>
          <Link to="/o/$orgId/workspaces" params={{ orgId }} className="underline">
            all workspaces
          </Link>{' '}
          · {data.slug}
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card title="Campaigns">
            {data.campaigns.length === 0 ? (
              <p className="text-sm text-muted">No campaigns in this workspace yet.</p>
            ) : (
              <ul className="divide-y divide-hair">
                {data.campaigns.map((campaign) => (
                  <li key={campaign.campaignId}>
                    <Link
                      to="/o/$orgId/campaigns/$campaignId"
                      params={{ orgId, campaignId: campaign.campaignId }}
                      className="flex items-center justify-between gap-4 py-2.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm text-ink">{campaign.name}</span>
                        <StatusPill value={campaign.state} vocabulary={CAMPAIGN_STATE} />
                      </div>
                      <Money value={campaign.allocated as MoneyValue} className="text-ink" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="People"
            description="Access to this workspace. A finance approver may set its ceiling — which is exactly the thing an organization-wide role cannot express, and why workspaces are their own tables."
          >
            <ul className="divide-y divide-hair">
              {data.members.map((member) => (
                <li
                  key={member.memberId}
                  className="flex items-center justify-between gap-4 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{member.email}</div>
                    <div className="text-xs capitalize text-muted">{member.orgRole}</div>
                  </div>
                  {member.isFinanceApprover && (
                    <span className="shrink-0 rounded-full bg-secured/10 px-2 py-0.5 text-[11px] font-medium text-secured">
                      Approves budgets
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          {editing ? (
            <EnvelopeForm
              orgId={orgId}
              workspaceId={workspaceId}
              committed={(envelope?.committed ?? {
                amountMinor: '0',
                currency: 'USD',
                exponent: 2,
              }) as MoneyValue}
              onDone={() => setEditing(false)}
            />
          ) : (
            <Card
              title="Approved budget"
              description="How much this workspace may commit to deals. The money itself stays in your organization balance."
              actions={
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => setEditing(true)}
                >
                  {envelope ? 'Change' : 'Approve'}
                </button>
              }
            >
              {envelope ? (
                <>
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <div className="text-xs font-medium text-muted">Left to commit</div>
                      <Money
                        value={envelope.remaining as MoneyValue}
                        size="lg"
                        className={
                          BigInt(envelope.remaining.amountMinor) === 0n
                            ? 'text-amber-800'
                            : 'text-ink'
                        }
                      />
                    </div>
                    <div className="text-right text-xs text-muted">
                      <div>
                        <Money value={envelope.committed as MoneyValue} className="text-ink" />{' '}
                        committed
                      </div>
                      <div>
                        of <Money value={envelope.ceiling as MoneyValue} className="text-ink" />
                      </div>
                    </div>
                  </div>

                  {envelope.approvedByEmail && (
                    <p className="mt-3 text-[11px] leading-relaxed text-muted">
                      Approved by {envelope.approvedByEmail}
                      {envelope.approvedAt && (
                        <>
                          {' '}
                          on{' '}
                          {formatDay(envelope.approvedAt)}
                        </>
                      )}
                      .
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm leading-relaxed text-muted">
                  No ceiling approved yet, so nothing can be allocated to campaigns in this
                  workspace.
                </p>
              )}
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
