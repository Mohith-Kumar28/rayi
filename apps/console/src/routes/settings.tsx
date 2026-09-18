import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  ApiError,
  useGetOrganization,
  useListInvitations,
  useRevokeInvitation,
  useUpdateOrganization,
} from '@rayi/api-client';

import { Money, type MoneyValue } from '../components/Money';
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
import { INVITATION_STATE, StatusPill } from '../components/StatusPill';

/**
 * Organization settings.
 *
 * Two things here are load-bearing rather than administrative:
 *
 * **The funding account is never editable from this screen.** There is no field
 * that takes a bank account number, and there must never be one — changing
 * where money comes from and goes to routes through the payment provider's own
 * verification, so the provider's identity checks are the second factor.
 *
 * **Pending invitations are shown as what they are**: unclaimed routes into this
 * organization. An invitation that only exists in somebody's mailbox is an
 * access grant nobody is reviewing.
 */

function InvitationRow({
  orgId,
  invitation,
}: {
  orgId: string;
  invitation: {
    invitationId: string;
    email: string;
    role: string;
    status: string;
    invitedByEmail: string;
    expiresAt: string;
  };
}) {
  const revoke = useRevokeInvitation();
  const expiresSoon = new Date(invitation.expiresAt).getTime() - Date.now() < 24 * 3600_000;

  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-ink">{invitation.email}</span>
          <StatusPill value={invitation.status} vocabulary={INVITATION_STATE} />
        </div>
        <div className="mt-0.5 text-xs text-muted">
          as {invitation.role} · invited by {invitation.invitedByEmail} ·{' '}
          {expiresSoon ? (
            <span className="text-amber-800">expires today</span>
          ) : (
            <>
              expires{' '}
              {new Date(invitation.expiresAt).toLocaleDateString('en-US', {
                day: 'numeric',
                month: 'short',
              })}
            </>
          )}
        </div>
      </div>

      {invitation.status === 'pending' && (
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={revoke.isPending || revoke.isSuccess}
          onClick={() => revoke.mutate({ orgId, invitationId: invitation.invitationId })}
        >
          {revoke.isSuccess ? 'Revoked' : 'Revoke'}
        </button>
      )}
    </li>
  );
}

export function SettingsScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/settings' });
  const organization = useGetOrganization(orgId);
  const invitations = useListInvitations(orgId);
  const update = useUpdateOrganization();

  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  if (organization.isPending) return <Loading what="settings" />;
  if (organization.isError) return <LoadFailed what="settings" />;

  const data = organization.data;
  const problem = update.error instanceof ApiError ? update.error.problem : null;
  const pending = invitations.data?.invitations.filter((row) => row.status === 'pending') ?? [];

  return (
    <Page title="Settings" width="narrow" subtitle="Your organization, its people and its money limits.">
      <div className="space-y-4">
        {data.frozen && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-900">Outgoing payments are paused</p>
            <p className="mt-1 text-sm leading-relaxed text-red-800">
              Money can still arrive and your campaigns keep running. Nothing is being released to
              creators until this is lifted.
            </p>
          </div>
        )}

        <Card title="Name">
          <div className="space-y-3">
            <Field label="Organization name" hint="Creators see this on every offer.">
              <input
                className={inputClass}
                value={name || data.name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Your authenticator code"
              hint="Renaming changes what creators see on offers you have already sent."
            >
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

            <button
              type="button"
              className={primaryButtonClass}
              disabled={update.isPending || code.length !== 6 || !name.trim() || name === data.name}
              onClick={() => update.mutate({ orgId, data: { name: name.trim(), code } })}
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
            {/* The slug is immutable, and the reason is given rather than the
                field just being absent. */}
            <p className="text-[11px] leading-relaxed text-muted">
              Your address <strong>{data.slug}</strong> cannot be changed — it appears in links
              other people already hold.
            </p>
          </div>
        </Card>

        <Card
          title="Daily release limit"
          description="The most that can be released to creators in one day. It exists so a single compromised account cannot empty your funds before anyone notices."
        >
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-muted">Used today</div>
              <Money value={data.dailyReleased as MoneyValue} size="lg" className="text-ink" />
            </div>
            <div className="text-right">
              <div className="text-xs font-medium text-muted">Limit</div>
              <Money
                value={data.dailyReleaseCeiling as MoneyValue}
                size="lg"
                className="text-muted"
              />
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Raising this is a conversation with us rather than a setting, on purpose — a limit your
            own account can lift is not a limit.
          </p>
        </Card>

        <Card
          title="Where your money comes from"
          description="Funding arrives from this account, and refunds go back to it — never anywhere else."
        >
          {data.bankAccountLast4 ? (
            <div className="flex items-center justify-between gap-4">
              <div className="text-sm text-ink">Account ending {data.bankAccountLast4}</div>
              <span className="text-xs capitalize text-muted">
                {data.bankAccountStatus.replace(/_/g, ' ')}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted">No account linked yet.</p>
          )}
          {/* No field here takes an account number, deliberately. */}
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Changing this happens with our payment provider, not here — so their identity checks
            stand between anyone and your bank details.
          </p>
        </Card>

        <Card
          title="Pending invitations"
          description="An invitation nobody has accepted is an unclaimed way into this organization."
        >
          {invitations.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : pending.length === 0 ? (
            <p className="text-sm text-muted">Nothing outstanding.</p>
          ) : (
            <ul className="divide-y divide-hair">
              {pending.map((invitation) => (
                <InvitationRow
                  key={invitation.invitationId}
                  orgId={orgId}
                  invitation={invitation}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}
