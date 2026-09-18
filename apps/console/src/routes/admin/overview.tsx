import { ApiError, useGetLedgerHealth, useGetPlatformStats, useListBrands } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';

/**
 * The super-admin overview.
 *
 * Two rules shape every number on this screen, and both exist because an
 * internal dashboard is where a business's understanding of itself comes from:
 *
 * **Funds under management is not revenue.** One is brands' money sitting at
 * Stripe; the other is what Rayi has earned. Conflating them is the single most
 * misleading thing a dashboard can do, and the mistake is then repeated in every
 * deck built from it. They are rendered in different sections with different
 * weight, and never summed.
 *
 * **Nothing here is live, and it says so.** The figures come from a snapshot the
 * worker computes every five minutes, because the api process cannot read the
 * ledger at all — its database role has no grants on that schema. A timestamp on
 * every figure is the difference between "four minutes old" and "wrong".
 */

/**
 * Pluralised counts.
 *
 * On this panel specifically, because the first real alarm is almost always
 * ONE problem — and "1 entries do not sum to zero" on the screen that tells an
 * operator the ledger has broken reads as a system that is not being looked
 * after, at the exact moment they most need to believe it is.
 */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-hair bg-white p-4">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-ink">
        {value}
      </div>
      {note && <p className="mt-1 text-[11px] leading-relaxed text-muted">{note}</p>}
    </div>
  );
}

/**
 * The most important thing on the page.
 *
 * Every list must be empty. A non-empty one means the ledger disagrees with
 * itself, and no other number on this screen can be trusted until it is
 * explained — so it is rendered first, and loudly.
 */
function LedgerHealth() {
  const health = useGetLedgerHealth();

  if (health.isPending) return null;
  if (health.isError) {
    return (
      <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-medium text-red-900">Could not check the books.</p>
      </div>
    );
  }

  const { unbalancedEntries, driftedAccounts, auditChainBreaks, failedCommands, checkedAt } =
    health.data;

  if (!checkedAt) {
    // Never checked is NOT the same as healthy, and must never render as a green
    // tick. That is the one thing this panel cannot be allowed to say falsely.
    return (
      <div className="mb-6 rounded-xl border border-hair bg-white p-4">
        <p className="text-sm font-medium text-ink">The books have not been checked yet</p>
        <p className="mt-1 text-xs text-muted">
          The worker computes this every five minutes. If this persists, the worker is not running.
        </p>
      </div>
    );
  }

  const problems =
    unbalancedEntries.length + driftedAccounts.length + auditChainBreaks.length + failedCommands;

  if (problems === 0) {
    return (
      <div className="mb-6 flex items-center justify-between rounded-xl border border-secured/30 bg-secured/5 px-4 py-3">
        <p className="text-sm font-medium text-secured">The books agree with themselves.</p>
        <p className="text-xs text-muted">
          checked {new Date(checkedAt).toLocaleTimeString('en-US')}
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-900">
        The ledger disagrees with itself. Nothing below can be trusted until this is explained.
      </p>
      <ul className="mt-2 space-y-1 text-sm text-red-800">
        {unbalancedEntries.length > 0 && (
          <li>
            {count(unbalancedEntries.length, 'entry does', 'entries do')} not sum to zero
          </li>
        )}
        {driftedAccounts.length > 0 && (
          <li>
            {count(driftedAccounts.length, 'account has', 'accounts have')} drifted from the sum of
            its lines
          </li>
        )}
        {auditChainBreaks.length > 0 && (
          <li>{count(auditChainBreaks.length, 'break', 'breaks')} in the audit log's hash chain</li>
        )}
        {failedCommands > 0 && (
          <li>
            {count(failedCommands, 'treasury command', 'treasury commands')}{' '}
            {failedCommands === 1 ? 'failed and was' : 'failed and were'} not resolved
          </li>
        )}
      </ul>
    </div>
  );
}

export function AdminOverviewScreen() {
  const stats = useGetPlatformStats();
  const brands = useListBrands();
  // Same query key as the panel below, so this is one fetch, not two.
  const health = useGetLedgerHealth();

  const statsProblem = stats.error instanceof ApiError ? stats.error.problem : null;

  /**
   * Whether the figures below can be believed.
   *
   * The panel says "nothing below can be trusted until this is explained".
   * Rendering the figures at full confidence underneath that sentence makes the
   * sentence decorative — so when the books disagree the numbers are physically
   * dimmed and labelled. A dashboard that tells you not to trust it while
   * looking exactly as authoritative as ever has told you nothing.
   */
  const booksSuspect = Boolean(
    health.data?.checkedAt &&
      (health.data.unbalancedEntries.length > 0 ||
        health.data.driftedAccounts.length > 0 ||
        health.data.auditChainBreaks.length > 0 ||
        health.data.failedCommands > 0),
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Platform</h1>
        <p className="mt-1 text-sm text-muted">
          Every brand on Rayi. This is the only surface that reads across tenants, and every query
          it makes is logged.
        </p>
      </header>

      <LedgerHealth />

      {statsProblem ? (
        <div className="mb-6 rounded-xl border border-hair bg-white p-4">
          <p className="text-sm font-medium text-ink">No figures yet</p>
          <p className="mt-1 text-xs text-muted">{statsProblem.detail ?? statsProblem.title}</p>
        </div>
      ) : stats.data ? (
        <div className={booksSuspect ? 'opacity-40 saturate-0' : undefined}>
          {booksSuspect && (
            <p className="mb-3 text-xs font-medium text-red-800">
              Shown for reference only — these came from the same books.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Brands" value={String(stats.data.brandCount)} />
            <Stat label="Creators" value={String(stats.data.creatorCount)} />
            <Stat label="Active deals" value={String(stats.data.activeDealCount)} />
            <Stat
              label="Awaiting review"
              value={String(stats.data.pendingReviews)}
              note="Across every brand."
            />
          </div>

          <section className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-hair bg-white p-5">
              <div className="text-xs font-medium text-muted">Platform revenue</div>
              <div className="mt-1">
                <Money
                  value={stats.data.platformRevenue as MoneyValue}
                  size="lg"
                  className="text-ink"
                />
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                Fees Rayi has actually earned. This is the business.
              </p>
            </div>

            <div className="rounded-xl border border-hair bg-canvas p-5">
              <div className="text-xs font-medium text-muted">Funds under management</div>
              <div className="mt-1">
                <Money
                  value={stats.data.fundsUnderManagement as MoneyValue}
                  size="lg"
                  className="text-muted"
                />
              </div>
              {/* Rendered deliberately quieter, in a different section, and never
                  summed with revenue. It is brands' money at Stripe — Rayi never
                  custodies it and it is not ours. */}
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                Brands' money, held at Stripe. <strong>Not revenue.</strong> Never add this to the
                figure on the left.
              </p>
            </div>
          </section>

          <p className="mt-3 text-[11px] text-muted">
            Computed {new Date(stats.data.computedAt).toLocaleString('en-US')} · the worker
            refreshes this every five minutes, because the API cannot read the ledger.
          </p>

          <section className="mt-4">
            <div className="rounded-xl border border-hair bg-white p-5">
              <div className="text-xs font-medium text-muted">Released to creators</div>
              <div className="mt-1">
                <Money
                  value={stats.data.releasedToCreators as MoneyValue}
                  size="lg"
                  className="text-secured"
                />
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                Money that has actually moved. Never anything merely approved.
              </p>
            </div>
          </section>
        </div>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-ink">Brands</h2>

        {brands.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : brands.isError ? (
          <p className="text-sm text-red-700">Could not load brands.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-hair bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-medium">Brand</th>
                  <th className="px-4 py-2.5 text-right font-medium">People</th>
                  <th className="px-4 py-2.5 text-right font-medium">Campaigns</th>
                  <th className="px-4 py-2.5 text-right font-medium">Active deals</th>
                  <th className="px-4 py-2.5 text-right font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {brands.data.brands.map((brand) => (
                  <tr key={brand.organizationId} className="border-b border-hair/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{brand.name}</div>
                      <div className="text-xs text-muted">{brand.slug}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      {brand.memberCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">
                      {brand.campaignCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink">
                      {brand.activeDealCount}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-muted">
                      {new Date(brand.createdAt).toLocaleDateString('en-US', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
