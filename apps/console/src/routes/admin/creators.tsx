import { useState } from 'react';
import { useListPlatformCreators } from '@rayi/api-client';

import { Money, type MoneyValue } from '../../components/Money';
import { Empty, LoadFailed, Loading, Page, inputClass } from '../../components/Shell';

/**
 * Every creator on the platform.
 *
 * The screen is organised around ONE question — who is owed money and cannot
 * receive it — because that is the only thing on it anybody acts on. A creator
 * with nothing owed and no payout method is not a problem; a creator with money
 * waiting and a blocked destination is a person, waiting.
 */
export function AdminCreatorsScreen() {
  const [search, setSearch] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const creators = useListPlatformCreators({
    ...(search ? { search } : {}),
    ...(blockedOnly ? { blockedOnly: true } : {}),
  });

  return (
    <Page
      title="Creators"
      subtitle="The population that receives the money, and the one with the weakest sign-in. Anyone who cannot be paid is listed first."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          aria-label="Search creators"
          className={`${inputClass} mt-0 max-w-xs`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by handle"
        />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={blockedOnly}
            onChange={(event) => setBlockedOnly(event.target.checked)}
          />
          Only those who cannot be paid
        </label>
      </div>

      {creators.isPending ? (
        <Loading what="creators" />
      ) : creators.isError ? (
        <LoadFailed what="creators" />
      ) : (
        <>
          {creators.data.blockedCount > 0 && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">
                {creators.data.blockedCount}{' '}
                {creators.data.blockedCount === 1 ? 'creator has' : 'creators have'} money owed and
                cannot receive it
              </p>
              <p className="mt-1 text-sm leading-relaxed text-amber-900">
                Their work is done and their money is sitting still. Nothing is lost, but nobody is
                being paid until their payout setup or hold is resolved.
              </p>
            </div>
          )}

          {creators.data.creators.length === 0 ? (
            <Empty
              title={search || blockedOnly ? 'Nobody matches' : 'No creators yet'}
              hint={
                blockedOnly
                  ? 'Everyone who is owed money can receive it. That is the state this screen exists to keep.'
                  : 'Creators appear once a brand offers them a deal.'
              }
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-hair bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5 font-medium">Creator</th>
                    <th className="px-4 py-2.5 font-medium">Payouts</th>
                    <th className="px-4 py-2.5 text-right font-medium">Brands</th>
                    <th className="px-4 py-2.5 text-right font-medium">Active</th>
                    <th className="px-4 py-2.5 text-right font-medium">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {creators.data.creators.map((creator) => {
                    const held =
                      creator.payoutHoldUntil && new Date(creator.payoutHoldUntil) > new Date();
                    return (
                      <tr key={creator.creatorId} className="border-b border-hair/60 last:border-0">
                        <td className="px-4 py-3">
                          <div className="font-medium text-ink">{creator.handle}</div>
                          <div className="text-xs text-muted">{creator.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          {!creator.payoutsEnabled ? (
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                              Not set up
                            </span>
                          ) : held ? (
                            <span className="rounded-full bg-clearing/10 px-2 py-0.5 text-[11px] font-medium text-clearing">
                              Paused to{' '}
                              {new Date(creator.payoutHoldUntil!).toLocaleDateString('en-US', {
                                day: 'numeric',
                                month: 'short',
                              })}
                            </span>
                          ) : (
                            <span className="text-[11px] text-muted">Ready</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted">
                          {creator.brandCount}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted">
                          {creator.activeDealCount}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Money
                            value={creator.totalReleased as MoneyValue}
                            className={
                              BigInt(creator.totalReleased.amountMinor) > 0n
                                ? 'text-secured'
                                : 'text-muted'
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
