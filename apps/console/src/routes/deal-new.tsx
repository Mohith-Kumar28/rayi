import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ApiError, useCreateDeal, useListCampaigns, usePreviewDeal } from '@rayi/api-client';

import { Money, formatMoney, type MoneyValue } from '../components/Money';
import {
  Card,
  Field,
  Page,
  inputClass,
  selectClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '../components/Shell';
// The one money parser. A second implementation here would be a second set of
// rounding rules, and the two would disagree on exactly the inputs nobody tested.
import { formatPercent, toMinorUnits } from '../lib/allocation';

/**
 * Authoring a deal.
 *
 * **The screen computes no money.** Every resolved amount, every odd cent and
 * every advance warning comes from `previewDeal`, which runs the same
 * `resolveMilestoneAmounts` and `isSatisfiableAtStart` the real acceptance path
 * freezes. A client-side preview would be a second implementation of money
 * arithmetic, and the two would disagree on exactly the inputs nobody tested —
 * a brand would consent to one number and a different one would be stored.
 *
 * **The advance disclosure is derived, not declared.** A milestone that is
 * satisfied against an empty deal is money that leaves before work exists and
 * cannot be recovered, whether it is typed as `ADVANCE`, as a count of zero, or
 * as a date already past. Because the server derives it from the condition, a
 * brand cannot sidestep the warning by expressing the same thing differently.
 */

type ConditionType =
  | 'ADVANCE'
  | 'DELIVERABLES_APPROVED_COUNT'
  | 'ALL_DELIVERABLES_APPROVED'
  | 'MANUAL_BRAND_APPROVAL'
  | 'DATE_REACHED';

interface MilestoneRow {
  readonly key: number;
  title: string;
  /** Major units as typed. Converted to minor exactly once, at submit. */
  amount: string;
  mode: 'fixed' | 'percent';
  percent: string;
  condition: ConditionType;
  count: string;
  date: string;
}

const CONDITION_LABEL: Record<ConditionType, string> = {
  ADVANCE: 'As soon as they accept',
  DELIVERABLES_APPROVED_COUNT: 'After N videos are approved',
  ALL_DELIVERABLES_APPROVED: 'When every video is approved',
  MANUAL_BRAND_APPROVAL: 'When I approve it myself',
  DATE_REACHED: 'On a date',
};

let nextKey = 1;
const blankMilestone = (): MilestoneRow => ({
  key: nextKey++,
  title: '',
  amount: '',
  mode: 'fixed',
  percent: '',
  condition: 'DELIVERABLES_APPROVED_COUNT',
  count: '',
  date: '',
});

export function NewDealScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/deals/new' });
  const navigate = useNavigate();
  const campaigns = useListCampaigns(orgId);
  const preview = usePreviewDeal();
  const create = useCreateDeal();

  const [campaignId, setCampaignId] = useState('');
  const [handle, setHandle] = useState('');
  const [total, setTotal] = useState('');
  const [slots, setSlots] = useState('');
  const [brief, setBrief] = useState('');
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  const totalMinor = toMinorUnits(total);
  const slotCount = Number.parseInt(slots, 10);
  const deliverables =
    Number.isInteger(slotCount) && slotCount > 0 && slotCount <= 200
      ? Array.from({ length: slotCount }, (_, i) => ({
          slot: `Video ${i + 1} of ${slotCount}`,
          brief: brief.trim() || null,
          dueAt: null,
        }))
      : [];

  const draft =
    totalMinor && deliverables.length > 0 && campaignId && handle.trim()
      ? {
          campaignId,
          creatorHandle: handle.trim(),
          total: { amountMinor: totalMinor, currency: 'USD' as const },
          deliverables,
          milestones: milestones.map((row) => ({
            title: row.title.trim() || 'Milestone',
            ...(row.mode === 'percent'
              ? {
                  /*
                   * Percent to basis points through the SAME exact parser.
                   *
                   * `Number('8.2') * 100` is 819.9999999999999, and rounding
                   * hides that until the input where it does not. A percentage
                   * is not money, but it decides money — "two decimal places to
                   * an integer" is the identical conversion, so it uses the
                   * identical tested function rather than a float.
                   */
                  percentageBps: Number(toMinorUnits(row.percent, 2) ?? '0'),
                }
              : { amount: { amountMinor: toMinorUnits(row.amount) ?? '0', currency: 'USD' as const } }),
            condition:
              row.condition === 'DELIVERABLES_APPROVED_COUNT'
                ? {
                    type: 'DELIVERABLES_APPROVED_COUNT' as const,
                    count: Number.parseInt(row.count || '0', 10) || 0,
                  }
                : row.condition === 'DATE_REACHED'
                  ? {
                      type: 'DATE_REACHED' as const,
                      date: row.date ? new Date(row.date).toISOString() : new Date().toISOString(),
                    }
                  : { type: row.condition },
          })),
        }
      : null;

  /*
   * Re-previewed whenever the draft changes.
   *
   * Debounced, because every keystroke in an amount field would otherwise be a
   * request — and because a preview that lands out of order would show the
   * arithmetic for a draft the person has already edited past.
   */
  const draftKey = draft ? JSON.stringify(draft) : '';
  useEffect(() => {
    if (!draftKey) return;
    const timer = setTimeout(() => {
      preview.mutate({ orgId, data: JSON.parse(draftKey) });
      // Consent is to a SPECIFIC advance figure. Any edit invalidates it.
      setAcknowledged(false);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, orgId]);

  const resolved = preview.data;
  const advanceMinor = resolved ? BigInt(resolved.advanceTotal.amountMinor) : 0n;
  const hasAdvance = advanceMinor > 0n;
  const problems = resolved?.problems ?? [];
  const createProblem = create.error instanceof ApiError ? create.error.problem : null;

  const canSubmit =
    Boolean(draft) &&
    problems.length === 0 &&
    Boolean(resolved?.balances) &&
    (!hasAdvance || acknowledged) &&
    !create.isPending;

  return (
    <Page
      title="New deal"
      width="narrow"
      subtitle="One creator, what they make, and what has to be true before each payment is released."
      actions={
        <Link to="/o/$orgId/deals" params={{ orgId }} className={secondaryButtonClass}>
          Cancel
        </Link>
      }
    >
      <div className="space-y-4">
        <Card title="The work">
          <div className="space-y-3">
            <Field label="Campaign">
              <select
                className={inputClass}
                value={campaignId}
                onChange={(event) => setCampaignId(event.target.value)}
              >
                <option value="">Select…</option>
                {campaigns.data?.campaigns.map((campaign) => (
                  <option key={campaign.campaignId} value={campaign.campaignId}>
                    {campaign.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Creator" hint="Their handle. They do not need a Rayi account yet.">
              <input
                className={inputClass}
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="@mayaonmain"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Deal total (USD)">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={total}
                  onChange={(event) => setTotal(event.target.value)}
                  placeholder="2400.00"
                />
              </Field>
              <Field label="How many videos">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={slots}
                  onChange={(event) => setSlots(event.target.value)}
                  placeholder="20"
                />
              </Field>
            </div>

            <Field label="Brief" hint="Optional. The creator sees this on every deliverable.">
              <textarea
                className={inputClass}
                rows={2}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card
          title="Payment schedule"
          description="Leave this empty and the whole total pays once every video is approved — which is the ordinary case and should stay one step."
          actions={
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => setMilestones((rows) => [...rows, blankMilestone()])}
            >
              Add milestone
            </button>
          }
        >
          {milestones.length === 0 ? (
            <p className="text-sm text-muted">
              One payment, on completion. Add a milestone to split it up.
            </p>
          ) : (
            <div className="space-y-3">
              {milestones.map((row, index) => (
                <div key={row.key} className="rounded-lg border border-hair p-3">
                  <div className="flex items-center gap-2">
                    <input
                      className={`${inputClass} mt-0 flex-1`}
                      value={row.title}
                      placeholder={`Milestone ${index + 1}`}
                      onChange={(event) =>
                        setMilestones((rows) =>
                          rows.map((item) =>
                            item.key === row.key ? { ...item, title: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label="Remove milestone"
                      className="rounded-lg border border-hair px-2 py-2 text-xs text-muted"
                      onClick={() =>
                        setMilestones((rows) => rows.filter((item) => item.key !== row.key))
                      }
                    >
                      Remove
                    </button>
                  </div>

                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="flex items-end gap-2">
                      <select
                        aria-label="Amount type"
                        className={selectClass}
                        value={row.mode}
                        onChange={(event) =>
                          setMilestones((rows) =>
                            rows.map((item) =>
                              item.key === row.key
                                ? { ...item, mode: event.target.value as 'fixed' | 'percent' }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="fixed">$</option>
                        <option value="percent">%</option>
                      </select>
                      <input
                        aria-label="Amount"
                        className={`${inputClass} mt-0 flex-1`}
                        inputMode="decimal"
                        value={row.mode === 'percent' ? row.percent : row.amount}
                        placeholder={row.mode === 'percent' ? '25' : '600.00'}
                        onChange={(event) =>
                          setMilestones((rows) =>
                            rows.map((item) =>
                              item.key === row.key
                                ? row.mode === 'percent'
                                  ? { ...item, percent: event.target.value }
                                  : { ...item, amount: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </div>

                    <select
                      aria-label="Releases"
                      className={`${inputClass} mt-0`}
                      value={row.condition}
                      onChange={(event) =>
                        setMilestones((rows) =>
                          rows.map((item) =>
                            item.key === row.key
                              ? { ...item, condition: event.target.value as ConditionType }
                              : item,
                          ),
                        )
                      }
                    >
                      {Object.entries(CONDITION_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {row.condition === 'DELIVERABLES_APPROVED_COUNT' && (
                    <input
                      aria-label="How many videos"
                      className={`${inputClass} mt-2`}
                      inputMode="numeric"
                      value={row.count}
                      placeholder="10"
                      onChange={(event) =>
                        setMilestones((rows) =>
                          rows.map((item) =>
                            item.key === row.key ? { ...item, count: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  )}
                  {row.condition === 'DATE_REACHED' && (
                    <input
                      aria-label="Date"
                      type="date"
                      className={`${inputClass} mt-2`}
                      value={row.date}
                      onChange={(event) =>
                        setMilestones((rows) =>
                          rows.map((item) =>
                            item.key === row.key ? { ...item, date: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {resolved && (
          <Card
            title="What this pays"
            description="Resolved by the server — the same arithmetic that gets frozen when the creator accepts."
          >
            <ul className="divide-y divide-hair">
              {resolved.milestones.map((item, index) => (
                <li key={index} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">{item.title}</div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.reason}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money
                      value={item.amount as MoneyValue}
                      precision="exact"
                      className="text-ink"
                    />
                    {item.percentageBps != null && (
                      <div className="text-[11px] text-muted">
                        {formatPercent(item.percentageBps)}%
                      </div>
                    )}
                  </div>
                </li>
              ))}
              {resolved.milestones.length === 0 && (
                <li className="py-2.5 text-sm text-muted">
                  One payment of {formatMoney(resolved.total as MoneyValue, 'exact')} once every
                  video is approved.
                </li>
              )}
            </ul>

            {resolved.milestones.length > 0 && (
              <div
                className={`mt-3 flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                  resolved.balances ? 'bg-canvas text-ink' : 'bg-red-50 text-red-800'
                }`}
              >
                <span>
                  {resolved.balances
                    ? 'Adds up to the deal total'
                    : 'These do not add up to the deal total'}
                </span>
                <span className="tabular-nums">
                  {formatMoney(resolved.milestoneTotal as MoneyValue, 'exact')} of{' '}
                  {formatMoney(resolved.total as MoneyValue, 'exact')}
                </span>
              </div>
            )}

            {problems.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-red-800">
                {problems.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {/*
          The advance disclosure.
          
          Shown because the SERVER said one or more milestones are satisfiable
          against an empty deal — not because a box was ticked. The consent is to
          a specific figure, and any edit to the draft clears it.
        */}
        {hasAdvance && resolved && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-900">
              {formatMoney(resolved.advanceTotal as MoneyValue, 'exact')} leaves before any work
              exists
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-amber-900">
              These milestones are satisfied the moment the creator accepts. Once released, the
              money is gone — Rayi cannot claw it back, and neither can your bank.
            </p>
            <label className="mt-3 flex items-start gap-2 text-sm text-amber-900">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I understand {formatMoney(resolved.advanceTotal as MoneyValue, 'exact')} is
                unrecoverable once this deal is accepted.
              </span>
            </label>
          </div>
        )}

        {createProblem && (
          <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <p className="font-medium text-amber-900">{createProblem.title}</p>
            {createProblem.detail && <p className="mt-1 text-amber-800">{createProblem.detail}</p>}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!canSubmit}
            className={primaryButtonClass}
            onClick={() => {
              if (!draft) return;
              create.mutate(
                { orgId, data: draft },
                {
                  onSuccess: (deal) =>
                    void navigate({
                      to: '/o/$orgId/deals/$dealId',
                      params: { orgId, dealId: deal.dealId },
                    }),
                },
              );
            }}
          >
            {create.isPending ? 'Saving…' : 'Save as draft'}
          </button>
          {/* Saving is not offering. Nothing is committed and no creator is
              contacted until the deal is explicitly offered from its own page. */}
          <p className="text-xs text-muted">
            Saves a draft. Nothing is committed and the creator is not contacted yet.
          </p>
        </div>
      </div>
    </Page>
  );
}
