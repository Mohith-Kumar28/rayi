import { useEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  ApiError,
  useApproveSubmission,
  useListReviewQueue,
  useRequestChanges,
  useUndoApproval,
  type ListReviewQueue200ExceptionsItem,
  type ListReviewQueue200ExceptionsItemChecksItem,
} from '@rayi/api-client';

import { Money, formatMoney, type MoneyValue } from '../components/Money';

/**
 * The review queue. The brand's core loop.
 *
 * Three things make three-seconds-a-row achievable, and all three are structural
 * rather than cosmetic:
 *
 * **1. Exceptions over lists.** The server returns rows that need a decision — a
 * failed or unverifiable check, or an approval that would release funds — plus
 * ONE collapsed bar for everything that cleared. A reviewer reads the
 * exceptions and approves the rest in a single action. A queue that shows
 * everything is a queue people abandon.
 *
 * **2. Keyboard first.** `a` approves, `c` requests changes, `j`/`k` move, `u`
 * undoes. A reviewer working a queue keeps their hands still; reaching for a
 * mouse per row is most of the three seconds.
 *
 * **3. A truthful pending state.** On approve, the row moves to a
 * `Releasing in 0:58 · Undo` lane. Felt speed is identical to optimistic
 * rendering, but the UI never asserts that money moved — which matters because
 * the notification layer may already have told the creator, and because it has
 * not moved: the release job runs after the window.
 */

/**
 * The generated row type, named rather than inferred from the hook.
 *
 * Inferring it through `ReturnType<typeof useListReviewQueue>` couples every
 * component signature to TanStack Query's generics, so a version bump that
 * changes them breaks files that have nothing to do with querying.
 */
type QueueRow = ListReviewQueue200ExceptionsItem;
type Check = ListReviewQueue200ExceptionsItemChecksItem;

/*
 * There is deliberately NO client-side copy of the undo window.
 *
 * The server returns `releasesAt` on every approval, and the countdown is driven
 * from that alone. A duplicated constant would drift the moment the server's
 * window changed, and the drift would show up as a countdown that reaches zero
 * while undo still works — or worse, an Undo button offered after the release
 * job has already run.
 */

function CheckBadge({ check }: { check: Check }) {
  // ERROR is NOT a failure. If our media pipeline crashed we could not verify
  // the work — and a creator must never be punished for our infrastructure. It
  // reads "could not verify", in a neutral colour, and never blocks.
  const style =
    check.status === 'PASS'
      ? 'bg-secured/10 text-secured'
      : check.status === 'FAIL'
        ? 'bg-red-50 text-red-700'
        : 'bg-pending/10 text-pending';

  const label =
    check.status === 'ERROR' ? `${check.name}: could not verify` : `${check.name}: ${check.status.toLowerCase()}`;

  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${style}`}>{label}</span>
  );
}

/**
 * The truthful pending lane.
 *
 * Counts down to when the release job may act. It says "releasing", never
 * "released" or "paid" — because nothing has moved, and the one thing this
 * screen must never do is assert a fact about money that may not have happened.
 */
function ReleasingRow({
  row,
  releasesAt,
  onUndo,
}: {
  row: QueueRow;
  releasesAt: number;
  onUndo: () => void;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, releasesAt - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => setRemaining(Math.max(0, releasesAt - Date.now())), 250);
    return () => clearInterval(timer);
  }, [releasesAt]);

  const seconds = Math.ceil(remaining / 1000);
  const expired = remaining <= 0;

  return (
    <li className="flex items-center justify-between gap-4 border-b border-hair/60 px-4 py-3 last:border-0">
      <div className="min-w-0">
        <div className="truncate text-sm text-ink">
          {row.creatorHandle} · {row.slot}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {expired
            ? 'Releasing now'
            : `Releasing in 0:${String(seconds).padStart(2, '0')}`}
          {row.releasesOnApproval && (
            <> · {formatMoney(row.releasesOnApproval as MoneyValue)}</>
          )}
        </div>
      </div>

      {!expired && (
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 rounded-lg border border-hair px-3 py-1.5 text-xs font-medium text-ink"
        >
          Undo <kbd className="ml-1 text-[10px] text-muted">u</kbd>
        </button>
      )}
    </li>
  );
}

function ExceptionRow({
  row,
  selected,
  onSelect,
  onApprove,
  onRequestChanges,
  busy,
}: {
  row: QueueRow;
  selected: boolean;
  onSelect: () => void;
  onApprove: () => void;
  onRequestChanges: () => void;
  busy: boolean;
}) {
  const failing = row.checks.filter((check: Check) => check.status !== 'PASS');

  return (
    <li
      onClick={onSelect}
      className={`cursor-pointer border-b border-hair/60 px-4 py-3 last:border-0 ${
        selected ? 'bg-canvas' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{row.creatorHandle}</span>
            <span className="shrink-0 text-xs text-muted">{row.slot}</span>
            {row.submissionVersion > 1 && (
              // A revision. The reviewer has seen this creator's work on this
              // slot before, and that changes how they read it.
              <span className="shrink-0 rounded-full bg-muted/10 px-2 py-0.5 text-[10px] text-muted">
                attempt {row.submissionVersion}
              </span>
            )}
          </div>

          <div className="mt-0.5 truncate text-xs text-muted">{row.campaignName}</div>

          {row.caption && (
            <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-ink">{row.caption}</p>
          )}

          {failing.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {failing.map((check: Check) => (
                <CheckBadge key={check.name} check={check} />
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 text-right">
          {row.releasesOnApproval && (
            // The money badge. This screen's whole job is making these rows
            // stand out from routine ones — approving this is a decision, not a
            // formality.
            <div className="mb-2">
              <span className="rounded-full bg-secured/10 px-2 py-1 text-xs font-medium text-secured">
                Releases <Money value={row.releasesOnApproval as MoneyValue} size="sm" />
              </span>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onRequestChanges();
              }}
              className="rounded-lg border border-hair px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
            >
              Changes <kbd className="ml-1 text-[10px] text-muted">c</kbd>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onApprove();
              }}
              className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Approve <kbd className="ml-1 text-[10px] text-white/60">a</kbd>
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function ReviewScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/review' });

  const queue = useListReviewQueue(orgId, undefined, {
    // Liveness while the tab is visible, rather than SSE. The signature moment
    // is the creator's phone buzzing inside TikTok, not a brand watching an open
    // tab — so the complexity budget goes to SMS and push, not to a socket.
    query: { refetchInterval: 10_000, refetchOnWindowFocus: true },
  });

  const approve = useApproveSubmission();
  const changes = useRequestChanges();
  const undo = useUndoApproval();

  const [cursor, setCursor] = useState(0);
  const [releasing, setReleasing] = useState<
    Array<{ row: QueueRow; reviewId: string; releasesAt: number }>
  >([]);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const rows = queue.data?.exceptions ?? [];
  const current = rows[cursor];

  function approveRow(row: QueueRow) {
    approve.mutate(
      {
        orgId,
        submissionId: row.submissionId,
        data: {
          // The ASSERTION. The server compares it against its own figure and
          // refuses on mismatch, so a stale queue cannot approve an amount the
          // reviewer never saw. No number sent from here becomes a number the
          // server pays.
          ...(row.releasesOnApproval
            ? { expectedReleaseMinor: row.releasesOnApproval.amountMinor }
            : { expectedReleaseMinor: '0' }),
        },
      },
      {
        onSuccess: (result) => {
          // Into the pending lane, NOT removed and NOT marked paid. Nothing has
          // moved yet.
          setReleasing((live) => [
            ...live,
            {
              row,
              reviewId: result.reviewId,
              releasesAt: new Date(result.releasesAt).getTime(),
            },
          ]);
          void queue.refetch();
        },
      },
    );
  }

  function undoRelease(entry: { reviewId: string }) {
    undo.mutate(
      { orgId, reviewId: entry.reviewId },
      {
        onSuccess: () => {
          setReleasing((live) => live.filter((item) => item.reviewId !== entry.reviewId));
          void queue.refetch();
        },
      },
    );
  }

  // Keyboard first. A reviewer working a queue keeps their hands still; reaching
  // for a mouse on every row is most of the three seconds.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal a key from someone typing a comment.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const list = queue.data?.exceptions ?? [];
      const row = list[cursorRef.current];

      switch (event.key) {
        case 'j':
          setCursor((index) => Math.min(index + 1, Math.max(0, list.length - 1)));
          break;
        case 'k':
          setCursor((index) => Math.max(0, index - 1));
          break;
        case 'a':
          if (row) approveRow(row);
          break;
        case 'c':
          if (row) {
            const comment = globalThis.prompt('What needs changing?');
            if (comment) {
              changes.mutate({ orgId, submissionId: row.submissionId, data: { comment } });
            }
          }
          break;
        case 'u': {
          // Undo the most recent, which is what "undo" means to a person.
          const latest = releasing[releasing.length - 1];
          if (latest) undoRelease(latest);
          break;
        }
        default:
          break;
      }
    }

    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data, releasing, orgId]);

  if (queue.isPending) return <p className="p-8 text-sm text-muted">Loading the queue…</p>;
  if (queue.isError) return <p className="p-8 text-sm text-red-700">Could not load the queue.</p>;

  const cleared = queue.data.cleared;
  const problem = approve.error instanceof ApiError ? approve.error.problem : null;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Review</h1>
          <p className="mt-1 text-sm text-muted">
            {rows.length === 0
              ? 'Nothing needs your attention.'
              : `${rows.length} ${rows.length === 1 ? 'video needs' : 'videos need'} a decision.`}
          </p>
        </div>
        <p className="text-xs text-muted">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>c</kbd> changes ·{' '}
          <kbd>u</kbd> undo
        </p>
      </header>

      {problem && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-medium text-amber-900">{problem.title}</p>
          {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
        </div>
      )}

      {releasing.length > 0 && (
        <section className="mb-4">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Releasing
          </h2>
          <ul className="overflow-hidden rounded-xl border border-hair bg-white">
            {releasing.map((entry) => (
              <ReleasingRow
                key={entry.reviewId}
                row={entry.row}
                releasesAt={entry.releasesAt}
                onUndo={() => undoRelease(entry)}
              />
            ))}
          </ul>
        </section>
      )}

      {rows.length > 0 && (
        <ul className="overflow-hidden rounded-xl border border-hair bg-white">
          {rows.map((row, index) => (
            <ExceptionRow
              key={row.submissionId}
              row={row}
              selected={index === cursor}
              busy={approve.isPending || changes.isPending}
              onSelect={() => setCursor(index)}
              onApprove={() => approveRow(row)}
              onRequestChanges={() => {
                const comment = globalThis.prompt('What needs changing?');
                if (comment) {
                  changes.mutate({ orgId, submissionId: row.submissionId, data: { comment } });
                }
              }}
            />
          ))}
        </ul>
      )}

      {cleared.count > 0 && (
        // ONE collapsed bar, not a list. "Exceptions over lists" made literal:
        // everything here passed every check and releases nothing, so reading it
        // row by row would be work with no decision at the end of it.
        <div className="mt-4 flex items-center justify-between rounded-xl border border-hair bg-white px-4 py-3">
          <div className="text-sm text-ink">
            <strong>{cleared.count}</strong> cleared all checks ·{' '}
            <span className="text-muted">releases nothing</span>
          </div>
          <button
            type="button"
            disabled={approve.isPending}
            className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            Approve all <kbd className="ml-1 text-[10px] text-white/60">A</kbd>
          </button>
        </div>
      )}

      {rows.length === 0 && cleared.count === 0 && releasing.length === 0 && (
        <div className="rounded-xl border border-hair bg-white p-10 text-center">
          <p className="text-sm font-medium text-ink">The queue is empty</p>
          <p className="mt-1 text-sm text-muted">
            Every video has been reviewed. New work appears here as creators submit it.
          </p>
        </div>
      )}
    </div>
  );
}
