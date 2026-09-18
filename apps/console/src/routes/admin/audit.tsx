import { useState } from 'react';
import { useListAuditEvents } from '@rayi/api-client';

import { Card, Empty, LoadFailed, Loading, Page, inputClass } from '../../components/Shell';

/**
 * The audit log, across tenants.
 *
 * Append-only and hash-chained, and the chain result is shown PER ROW rather
 * than as a single count — a break that is located is a break somebody can
 * investigate, where "1 break somewhere in 10,000 rows" is only anxiety.
 *
 * Note what is deliberately NOT here: a gap check on the sequence. The column is
 * `GENERATED ALWAYS AS IDENTITY`, which is monotonic but not gapless — a
 * rolled-back transaction burns a value — so a gap alarm would fire on every
 * failed request and be switched off within a week.
 */
export function AdminAuditScreen() {
  const [action, setAction] = useState('');
  const [moneyOnly, setMoneyOnly] = useState(false);
  const events = useListAuditEvents({
    ...(action ? { action } : {}),
    ...(moneyOnly ? { moneyOnly: true } : {}),
  });

  return (
    <Page
      title="Audit log"
      subtitle="Every state-changing action, hash-chained so a row cannot be altered without the chain saying so."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          aria-label="Filter by action"
          className={`${inputClass} mt-0 max-w-xs`}
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Filter by action, e.g. money_authority"
        />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={moneyOnly}
            onChange={(event) => setMoneyOnly(event.target.checked)}
          />
          Money events only
        </label>
      </div>

      {events.isPending ? (
        <Loading what="the log" />
      ) : events.isError ? (
        <LoadFailed what="the log" />
      ) : (
        <>
          {events.data.chainBreakCount > 0 ? (
            <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-900">
                {events.data.chainBreakCount === 1
                  ? '1 row no longer matches the chain'
                  : `${events.data.chainBreakCount} rows no longer match the chain`}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-red-800">
                The audit log is append-only and every row is hashed with the one before it. A row
                that no longer matches was altered after it was written — it is marked below, so
                the break is located rather than merely counted.
              </p>
            </div>
          ) : (
            <div className="mb-4 rounded-xl border border-secured/30 bg-secured/5 px-4 py-3">
              <p className="text-sm font-medium text-secured">
                Every row still matches the chain.
              </p>
            </div>
          )}

          {events.data.events.length === 0 ? (
            <Empty title="Nothing matches" hint="Try a different action or clear the filters." />
          ) : (
            <Card className="p-0">
              <ul className="divide-y divide-hair">
                {events.data.events.map((event) => (
                  <li
                    key={event.seq}
                    className={`px-4 py-3 ${event.chainValid ? '' : 'bg-red-50'}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-ink">{event.label}</span>
                          {!event.chainValid && (
                            <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-800">
                              altered
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {/* The machine key stays visible: it is what an alert
                              matches on and what an investigator greps for. */}
                          <span className="font-mono">{event.action}</span>
                          {event.actorEmail && <> · {event.actorEmail}</>}
                          {event.organizationName && <> · {event.organizationName}</>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted">
                        <div>
                          {new Date(event.occurredAt).toLocaleString('en-US', {
                            day: 'numeric',
                            month: 'short',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </div>
                        <div className="font-mono text-[10px]">#{event.seq}</div>
                        {event.ipAddress && <div>{event.ipAddress}</div>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
