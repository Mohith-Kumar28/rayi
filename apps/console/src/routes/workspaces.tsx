import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ApiError, useCreateWorkspace, useListWorkspaces } from '@rayi/api-client';

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
import { formatDay } from '../lib/dates';

/**
 * Workspaces.
 *
 * **A workspace holds no money.** It groups campaigns and people, and its
 * budget envelope is an AUTHORIZATION CEILING — finance approves how much may
 * be allocated beneath it, and campaigns still draw from the organization
 * balance itself.
 *
 * The screen has to make that distinction survive contact with a reader, because
 * "budget" naturally reads as "a pot of money that is here". The copy therefore
 * says approved and used rather than balance and spent, and the exhausted case
 * says explicitly what does and does not stop.
 */

function EnvelopeBar({
  ceiling,
  committed,
}: {
  ceiling: MoneyValue;
  committed: MoneyValue;
}) {
  const ceilingMinor = BigInt(ceiling.amountMinor);
  const committedMinor = BigInt(committed.amountMinor);
  // Integer arithmetic throughout, then one division for a percentage that is
  // only ever used to size a bar — never to display an amount.
  const pct =
    ceilingMinor === 0n
      ? 0
      : Number((committedMinor * 100n) / ceilingMinor) > 100
        ? 100
        : Number((committedMinor * 100n) / ceilingMinor);
  const exhausted = ceilingMinor > 0n && committedMinor >= ceilingMinor;

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-hair">
      <div
        className={`h-full rounded-full ${exhausted ? 'bg-amber-500' : 'bg-ink'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function NewWorkspaceForm({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const create = useCreateWorkspace();
  const [name, setName] = useState('');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const problem = create.error instanceof ApiError ? create.error.problem : null;

  return (
    <Card
      title="New workspace"
      description="A workspace groups campaigns and people. It holds no money — finance approves a ceiling for it separately."
    >
      <div className="space-y-3">
        <Field
          label="Name"
          hint={slug ? `URL: /workspaces/${slug} — this cannot be changed later.` : undefined}
        >
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="UK market"
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
            disabled={create.isPending || !name.trim() || !slug}
            onClick={() =>
              create.mutate({ orgId, data: { name: name.trim(), slug } }, { onSuccess: onDone })
            }
          >
            {create.isPending ? 'Creating…' : 'Create workspace'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

export function WorkspacesScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/workspaces' });
  const workspaces = useListWorkspaces(orgId);
  const [creating, setCreating] = useState(false);

  if (workspaces.isPending) return <Loading what="workspaces" />;
  if (workspaces.isError) return <LoadFailed what="workspaces" />;

  const rows = workspaces.data.workspaces;

  return (
    <Page
      title="Workspaces"
      subtitle="A sub-brand, product line or market. Workspaces group campaigns and people; the money stays in one place and finance approves how much each workspace may commit."
      actions={
        !creating && (
          <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
            New workspace
          </button>
        )
      }
    >
      {creating && (
        <div className="mb-4">
          <NewWorkspaceForm orgId={orgId} onDone={() => setCreating(false)} />
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          title="No workspaces yet"
          hint="Most organizations start with one. Add more when different teams need their own approved budget."
          action={
            <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}>
              New workspace
            </button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((workspace) => {
            const envelope = workspace.envelope;
            const exhausted =
              envelope != null && BigInt(envelope.remaining.amountMinor) === 0n;

            return (
              <Link
                key={workspace.workspaceId}
                to="/o/$orgId/workspaces/$workspaceId"
                params={{ orgId, workspaceId: workspace.workspaceId }}
                className="block rounded-xl border border-hair bg-white p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">{workspace.name}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {workspace.campaignCount}{' '}
                      {workspace.campaignCount === 1 ? 'campaign' : 'campaigns'} ·{' '}
                      {workspace.memberCount} {workspace.memberCount === 1 ? 'person' : 'people'}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    {envelope ? (
                      <>
                        <div className="text-xs font-medium text-muted">Left to commit</div>
                        <Money
                          value={envelope.remaining as MoneyValue}
                          className={exhausted ? 'text-amber-800' : 'text-ink'}
                        />
                      </>
                    ) : (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                        No approved budget
                      </span>
                    )}
                  </div>
                </div>

                {envelope && (
                  <div className="mt-3">
                    <EnvelopeBar
                      ceiling={envelope.ceiling as MoneyValue}
                      committed={envelope.committed as MoneyValue}
                    />
                    <p className="mt-1.5 text-[11px] text-muted">
                      <Money value={envelope.committed as MoneyValue} className="text-ink" /> of{' '}
                      <Money value={envelope.ceiling as MoneyValue} className="text-ink" /> approved
                      {envelope.expiresAt && (
                        <>
                          {' '}
                          · expires{' '}
                          {formatDay(envelope.expiresAt)}
                        </>
                      )}
                    </p>
                    {/*
                      The exhausted case, stated precisely. What stops is NEW
                      commitments; what keeps running is every deal already
                      accepted — a creator mid-way through agreed work never
                      loses their milestone because someone else spent the budget.
                    */}
                    {exhausted && (
                      <p className="mt-1.5 text-[11px] leading-relaxed text-amber-800">
                        Fully committed. New deals cannot be offered from this workspace until
                        finance raises the ceiling. Deals already accepted are unaffected and will
                        pay out normally.
                      </p>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </Page>
  );
}
