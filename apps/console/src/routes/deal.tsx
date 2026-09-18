import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ApiError, useGetDeal, useOfferDeal, useTerminateDeal } from '@rayi/api-client';

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
import { DEAL_STATE, DELIVERABLE_STATE, StatusPill } from '../components/StatusPill';
import { formatPercent } from '../lib/allocation';

/**
 * One deal, from the brand's side.
 *
 * The two state-changing actions here are the only ones on the brand surface
 * that move money on a schedule rather than on a click, and both are written to
 * say exactly that:
 *
 * **Offering** commits the total against the campaign allocation and, if there
 * is an advance, sends money the moment the creator accepts. It needs step-up
 * and it re-asserts the advance figure the brand saw.
 *
 * **Terminating** releases nothing and claws nothing back. Money already
 * released stays released, because payout is final — the screen says so rather
 * than letting someone discover it.
 */

function ConditionSentence({ reason }: { reason: string }) {
  return <p className="mt-0.5 text-xs leading-relaxed text-muted">{reason}</p>;
}

function OfferPanel({
  orgId,
  dealId,
  advanceMinor,
  currency,
  exponent,
}: {
  orgId: string;
  dealId: string;
  advanceMinor: bigint;
  currency: string;
  exponent: number;
}) {
  const offer = useOfferDeal();
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const hasAdvance = advanceMinor > 0n;
  const problem = offer.error instanceof ApiError ? offer.error.problem : null;

  return (
    <Card
      title="Send this to the creator"
      description="Commits the total against the campaign allocation and sends the offer. They can accept or decline."
    >
      {hasAdvance && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">
            {formatMoney({ amountMinor: String(advanceMinor), currency, exponent }, 'exact')}{' '}
            releases the moment they accept
          </p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            Before any work exists, and it cannot be recovered afterwards.
          </p>
          <label className="mt-2 flex items-start gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>I understand this is unrecoverable.</span>
          </label>
        </div>
      )}

      {hasAdvance && (
        <Field label="Your authenticator code" hint="Sending money needs a fresh security check.">
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
      )}

      {problem && (
        <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">{problem.title}</p>
          {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
        </div>
      )}

      <button
        type="button"
        className={`${primaryButtonClass} mt-3`}
        disabled={offer.isPending || (hasAdvance && (!acknowledged || code.length !== 6))}
        onClick={() =>
          offer.mutate({
            orgId,
            dealId,
            data: {
              // The ASSERTION. The server re-derives the advance from the deal
              // and refuses on mismatch, so a stale screen cannot consent on the
              // brand's behalf to a figure they never saw.
              acknowledgedAdvanceMinor: String(advanceMinor),
              ...(hasAdvance ? { code } : {}),
            },
          })
        }
      >
        {offer.isPending ? 'Sending…' : 'Send offer'}
      </button>
    </Card>
  );
}

function TerminatePanel({ orgId, dealId }: { orgId: string; dealId: string }) {
  const terminate = useTerminateDeal();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');

  const problem = terminate.error instanceof ApiError ? terminate.error.problem : null;

  if (terminate.data) {
    return (
      <Card title="Deal ended">
        <p className="text-sm text-ink">
          <Money value={terminate.data.returned as MoneyValue} precision="exact" /> went back to the
          campaign.
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Money already released to the creator stays with them. Payout is final.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
        End this deal early
      </button>
    );
  }

  return (
    <Card
      title="End this deal early"
      description="Money already released stays with the creator — payout is final. The uncommitted remainder goes back to the campaign."
    >
      <div className="space-y-3">
        <Field label="Why" hint="The creator sees this.">
          <textarea
            className={inputClass}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
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
            disabled={terminate.isPending || !reason.trim() || code.length !== 6}
            onClick={() =>
              terminate.mutate({ orgId, dealId, data: { reason: reason.trim(), code } })
            }
          >
            {terminate.isPending ? 'Ending…' : 'End the deal'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Deliverables, as exceptions rather than as a list.
 *
 * A twenty-video deal renders eleven identical "Not started" rows, which is
 * eleven rows of nothing on the screen a brand opens to find out where the deal
 * stands. The same argument the review queue is built on applies here: what
 * matters is what has moved and what needs attention, and the rest is one line.
 *
 * The full list stays one click away, because "show me everything" is a real
 * thing to want — it is just not the default.
 */
function DeliverableList({
  deliverables,
}: {
  deliverables: ReadonlyArray<{
    deliverableId: string;
    slot: string;
    state: string;
    latestVersion: number;
  }>;
}) {
  const [expanded, setExpanded] = useState(false);

  const notStarted = deliverables.filter((row) => row.state === 'pending');
  const started = deliverables.filter((row) => row.state !== 'pending');
  const shown = expanded ? deliverables : started;

  return (
    <Card
      title="Deliverables"
      actions={
        notStarted.length > 0 && (
          <button
            type="button"
            className="text-xs font-medium text-muted underline"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Hide not started' : 'Show all'}
          </button>
        )
      }
    >
      {shown.length === 0 ? (
        <p className="text-sm text-muted">Nothing submitted yet.</p>
      ) : (
        <ul className="divide-y divide-hair">
          {shown.map((deliverable) => (
            <li
              key={deliverable.deliverableId}
              className="flex items-center justify-between gap-4 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-ink">{deliverable.slot}</div>
                {deliverable.latestVersion > 1 && (
                  <div className="text-xs text-muted">attempt {deliverable.latestVersion}</div>
                )}
              </div>
              <StatusPill value={deliverable.state} vocabulary={DELIVERABLE_STATE} />
            </li>
          ))}
        </ul>
      )}

      {!expanded && notStarted.length > 0 && (
        <p className="mt-3 border-t border-hair pt-3 text-sm text-muted">
          <strong className="text-ink">{notStarted.length}</strong>{' '}
          {notStarted.length === 1 ? 'video has' : 'videos have'} not been started.
        </p>
      )}
    </Card>
  );
}

export function DealScreen() {
  const { orgId, dealId } = useParams({ from: '/o/$orgId/deals/$dealId' });
  const deal = useGetDeal(orgId, dealId);

  if (deal.isPending) return <Loading what="this deal" />;
  if (deal.isError) return <LoadFailed what="this deal" />;

  const data = deal.data;
  const advanceMinor = data.milestones.reduce(
    (sum, milestone) =>
      milestone.satisfiableAtStart && !milestone.releasedAt
        ? sum + BigInt(milestone.amount.amountMinor)
        : sum,
    0n,
  );

  return (
    <Page
      title={data.creatorHandle}
      subtitle={
        <>
          <Link
            to="/o/$orgId/campaigns/$campaignId"
            params={{ orgId, campaignId: data.campaignId }}
            className="underline"
          >
            {data.campaignName}
          </Link>{' '}
          · created{' '}
          {new Date(data.createdAt).toLocaleDateString('en-US', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </>
      }
      actions={<StatusPill value={data.state} vocabulary={DEAL_STATE} />}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-baseline gap-8">
              <div>
                <div className="text-xs font-medium text-muted">Deal worth</div>
                <Money value={data.total as MoneyValue} size="lg" className="text-ink" />
              </div>
              <div>
                <div className="text-xs font-medium text-muted">Released</div>
                <Money value={data.released as MoneyValue} size="lg" className="text-secured" />
                <p className="mt-0.5 text-[11px] text-muted">Actually moved.</p>
              </div>
              <div>
                <div className="text-xs font-medium text-muted">Videos approved</div>
                <div className="text-2xl font-semibold tabular-nums tracking-tight text-ink">
                  {data.deliverablesApproved}/{data.deliverablesTotal}
                </div>
              </div>
            </div>
          </Card>

          <Card
            title="Payment schedule"
            description="Amounts were frozen when the deal was accepted. A percentage is never re-evaluated later — that would rewrite money that has already left."
          >
            <ul className="divide-y divide-hair">
              {data.milestones.map((milestone) => (
                <li key={milestone.milestoneId} className="py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">{milestone.title}</span>
                        {milestone.releasedAt ? (
                          <span className="shrink-0 rounded-full bg-secured/10 px-2 py-0.5 text-[11px] font-medium text-secured">
                            Released
                          </span>
                        ) : milestone.satisfiableAtStart ? (
                          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            Advance
                          </span>
                        ) : (
                          <span className="shrink-0 rounded-full bg-muted/10 px-2 py-0.5 text-[11px] font-medium text-muted">
                            Locked
                          </span>
                        )}
                      </div>
                      <ConditionSentence reason={milestone.reason} />
                    </div>
                    <div className="shrink-0 text-right">
                      <Money
                        value={milestone.amount as MoneyValue}
                        precision="exact"
                        className="text-ink"
                      />
                      {milestone.percentageBps != null && (
                        <div className="text-[11px] text-muted">
                          {formatPercent(milestone.percentageBps)}% of the
                          total
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <DeliverableList deliverables={data.deliverables} />
        </div>

        <div className="space-y-4">
          {data.state === 'draft' && (
            <OfferPanel
              orgId={orgId}
              dealId={dealId}
              advanceMinor={advanceMinor}
              currency={data.total.currency}
              exponent={data.total.exponent}
            />
          )}

          <Card title="Agreement history" description="An accepted agreement is never edited.">
            <ul className="space-y-2">
              {data.agreementVersions.map((version) => (
                <li key={version.version} className="flex items-baseline justify-between gap-3">
                  <div className="text-sm text-ink">Version {version.version}</div>
                  <div className="text-right text-xs text-muted">
                    <Money value={version.total as MoneyValue} className="text-ink" />
                    <div>
                      {version.acceptedAt
                        ? `accepted ${new Date(version.acceptedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}`
                        : 'not accepted'}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          {['offered', 'accepted', 'active'].includes(data.state) && (
            <TerminatePanel orgId={orgId} dealId={dealId} />
          )}
        </div>
      </div>
    </Page>
  );
}
