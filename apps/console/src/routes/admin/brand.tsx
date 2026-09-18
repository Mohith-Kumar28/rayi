import { Link, useParams } from '@tanstack/react-router';
import { useGetBrandDetail } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';
import { Card, LoadFailed, Loading, Page } from '../../components/Shell';

/**
 * One brand, from the platform side.
 *
 * The money figures come from the worker-computed snapshot, never live: the api
 * process has no grants on the ledger schema at all, so a live read would fail
 * in production while passing in development as a superuser — the worst kind of
 * difference, because it only shows up once real money is behind it. The
 * timestamp is therefore shown on every figure rather than implied.
 */
export function AdminBrandScreen() {
  const { brandId } = useParams({ from: '/admin/brands/$brandId' });
  const brand = useGetBrandDetail(brandId);

  if (brand.isPending) return <Loading what="this brand" />;
  if (brand.isError) return <LoadFailed what="this brand" />;

  const data = brand.data;

  return (
    <Page
      title={data.name}
      subtitle={
        <>
          <Link to="/admin" className="underline">
            all brands
          </Link>{' '}
          · {data.slug} · joined{' '}
          {new Date(data.createdAt).toLocaleDateString('en-US', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </>
      }
    >
      {data.frozen && (
        <div className="mb-4 rounded-xl border border-red-300 bg-red-50 p-4">
          <p className="text-sm font-semibold text-red-900">Outgoing payments are frozen</p>
          <p className="mt-1 text-sm leading-relaxed text-red-800">
            Money can still arrive and webhooks are still processed — freezing ingestion would burn
            the provider's retry window and turn this into a silent problem.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Funded', value: data.funded, note: 'Brought in from their bank.' },
          { label: 'Allocated', value: data.allocated, note: 'Committed to campaigns.' },
          { label: 'Released', value: data.released, note: 'Actually paid to creators.' },
        ].map((figure) => (
          <div key={figure.label} className="rounded-xl border border-hair bg-white p-4">
            <div className="text-xs font-medium text-muted">{figure.label}</div>
            <div className="mt-1">
              <Money
                value={figure.value as MoneyValue}
                size="lg"
                className={figure.label === 'Released' ? 'text-secured' : 'text-ink'}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted">{figure.note}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-muted">
        {data.computedAt ? (
          <>
            Computed {new Date(data.computedAt).toLocaleString('en-US')} · the worker refreshes this
            every five minutes, because the API cannot read the ledger.
          </>
        ) : (
          // Never computed is not the same as zero, and must not render as it.
          <>No snapshot computed yet — these figures are unavailable rather than zero.</>
        )}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card title="Workspaces">
          <ul className="divide-y divide-hair">
            {data.workspaces.map((workspace) => (
              <li
                key={workspace.workspaceId}
                className="flex items-center justify-between gap-4 py-2.5 text-sm"
              >
                <span className="truncate text-ink">{workspace.name}</span>
                <span className="shrink-0 text-xs text-muted">
                  {workspace.campaignCount}{' '}
                  {workspace.campaignCount === 1 ? 'campaign' : 'campaigns'}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Who can act" description="Owners and admins. Money capability is separate.">
          <ul className="divide-y divide-hair">
            {data.owners.map((owner) => (
              <li
                key={owner.email}
                className="flex items-center justify-between gap-4 py-2.5 text-sm"
              >
                <span className="truncate text-ink">{owner.email}</span>
                <span className="shrink-0 text-xs capitalize text-muted">{owner.role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Funding account: {data.bankAccountStatus.replace(/_/g, ' ')}.
          </p>
        </Card>
      </div>
    </Page>
  );
}
