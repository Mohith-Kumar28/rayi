import { useState } from 'react';
import { useListTreasuryCommands, useListWebhookDeliveries } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';
import { Card, Empty, LoadFailed, Loading, Page } from '../../components/Shell';
import { COMMAND_STATE, StatusPill, WEBHOOK_STATE } from '../../components/StatusPill';

/**
 * The operations screen.
 *
 * Two queues, and both are money with a fuse on it.
 *
 * **Treasury commands** are the internal RPC: a row plus a job, written inside
 * the caller's transaction. So a `failed` command is money work that was
 * requested and did not happen, and a command claimed hours ago is a worker that
 * died holding the lease. Neither announces itself anywhere else.
 *
 * **Webhook deliveries** are worse, because they are silent by construction. A
 * verified delivery nobody processed has a three-day fuse — the provider retries
 * for that long and then stops — and an ACH return arrives through this path as
 * a dispute. Losing one means a brand's money came back and the ledger never
 * heard about it.
 */

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One panel, not one per condition.
 *
 * Three stacked red boxes is half a screen of alarm with no order to it, and an
 * operator reading it cannot tell which to open first. Collapsed into a single
 * panel the counts are comparable at a glance, and the panel disappears
 * entirely when there is nothing wrong — which is what makes its presence mean
 * something.
 */
function Alarms({
  problems,
}: {
  problems: ReadonlyArray<{ count: number; singular: string; plural: string; detail: string }>;
}) {
  const live = problems.filter((problem) => problem.count > 0);
  if (live.length === 0) {
    return (
      <div className="mb-6 rounded-xl border border-secured/30 bg-secured/5 px-4 py-3">
        <p className="text-sm font-medium text-secured">
          Both queues are clear. Every command completed and every delivery was processed.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">
        {live.length === 1 ? 'Something needs attention' : `${live.length} things need attention`}
      </p>
      <ul className="mt-2 space-y-2">
        {live.map((problem) => (
          <li key={problem.singular}>
            <p className="text-sm font-medium text-red-900">
              {problem.count} {problem.count === 1 ? problem.singular : problem.plural}
            </p>
            <p className="text-sm leading-relaxed text-red-800">{problem.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AdminOpsScreen() {
  const [failedOnly, setFailedOnly] = useState(false);
  const commands = useListTreasuryCommands(
    {},
    { query: { refetchInterval: 15_000 } },
  );
  const webhooks = useListWebhookDeliveries(failedOnly ? { failedOnly: true } : {});

  if (commands.isPending) return <Loading what="the queues" />;
  if (commands.isError) return <LoadFailed what="the queues" />;

  return (
    <Page
      title="Operations"
      subtitle="The two queues that carry money. Everything here either completed, or is a person waiting."
    >
      <Alarms
        problems={[
          {
            count: commands.data.failedCount,
            singular: 'treasury command failed',
            plural: 'treasury commands failed',
            detail:
              'Money work that was requested and did not happen. Every one of these is somebody waiting for a payment a screen has already told them about.',
          },
          {
            count: commands.data.stuckCount,
            singular: 'command is stuck',
            plural: 'commands are stuck',
            detail:
              'Claimed by a worker that never finished. It will not retry until the lease expires.',
          },
          {
            count: webhooks.data?.unprocessedCount ?? 0,
            singular: 'webhook was received and never processed',
            plural: 'webhooks were received and never processed',
            detail:
              'The provider retries for about three days and then stops. An ACH return arrives this way — losing one means money came back and the ledger never heard.',
          },
        ]}
      />

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">Treasury commands</h2>
        {commands.data.commands.length === 0 ? (
          <Empty title="Nothing queued" hint="Every command that was written has completed." />
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-hair">
              {commands.data.commands.map((command) => (
                <li key={command.commandId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-ink">{command.kind}</span>
                        <StatusPill value={command.state} vocabulary={COMMAND_STATE} />
                        {command.attempts > 1 && (
                          <span className="shrink-0 text-[11px] text-muted">
                            {command.attempts} attempts
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted">
                        {command.organizationName} · {timeAgo(command.createdAt)}
                        {command.claimedBy && <> · held by {command.claimedBy}</>}
                      </div>
                      {command.lastError && (
                        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-800">
                          {command.lastError}
                        </p>
                      )}
                    </div>
                    {command.expectedAvailable && (
                      <div className="shrink-0 text-right">
                        <div className="text-[10px] uppercase tracking-wide text-muted">
                          Expected available
                        </div>
                        <Money
                          value={command.expectedAvailable as MoneyValue}
                          className="text-muted"
                        />
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Webhook deliveries</h2>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(event) => setFailedOnly(event.target.checked)}
            />
            Failed only
          </label>
        </div>

        {webhooks.isPending ? (
          <Loading what="deliveries" />
        ) : webhooks.isError ? (
          <LoadFailed what="deliveries" />
        ) : webhooks.data.deliveries.length === 0 ? (
          <Empty title="Nothing here" hint="No deliveries match that filter." />
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-hair">
              {webhooks.data.deliveries.map((delivery) => (
                <li
                  key={delivery.deliveryId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-ink">{delivery.eventType}</span>
                      <StatusPill value={delivery.state} vocabulary={WEBHOOK_STATE} />
                      {/*
                        A failed signature is shown rather than dropped. A burst
                        of them is either a rotated secret or somebody probing,
                        and both are things to see rather than infer from silence.
                      */}
                      {!delivery.signatureValid && (
                        <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                          signature failed
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {delivery.source.replace(/_/g, ' ')} · {timeAgo(delivery.receivedAt)}
                    </div>
                    {delivery.lastError && (
                      <p className="mt-1 text-xs text-red-800">{delivery.lastError}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </Page>
  );
}
