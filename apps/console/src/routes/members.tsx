import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import {
  ApiError,
  useChangeMemberRole,
  useInviteMember,
  useListMembers,
  useRemoveMember,
} from '@rayi/api-client';

/**
 * The people in an organization.
 *
 * The screen's real job is making **money capability visible**. It is granted
 * separately from any role — deliberately, so that inviting someone can never
 * make them able to move funds — which means it is also invisible unless a
 * surface like this shows it. Capability nobody can see is capability nobody
 * audits.
 */

type Role = 'owner' | 'admin' | 'member';

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

function Problem({ error }: { error: unknown }) {
  if (!(error instanceof ApiError)) return null;
  return (
    <div role="alert" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-900">{error.problem.title}</p>
      {error.problem.detail && <p className="mt-1 text-amber-800">{error.problem.detail}</p>}
      <p className="mt-2 font-mono text-[11px] text-amber-700">{error.problem.code}</p>
    </div>
  );
}

/**
 * The confirmation a privilege change requires.
 *
 * Rendered inline rather than as a modal, and it names the member and the role
 * being confirmed — because the grant the server mints is bound to exactly those
 * values. A dialog that said "confirm this change" without saying WHICH would be
 * asking for a signature on a blank page.
 */
function ConfirmRoleChange({
  email,
  role,
  onConfirm,
  onCancel,
  pending,
}: {
  email: string;
  role: Role;
  onConfirm: (code: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [code, setCode] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm(code);
      }}
      className="mt-3 rounded-lg border border-hair bg-canvas p-4"
    >
      <p className="text-sm text-ink">
        Make <strong>{email}</strong> a{' '}
        <strong>{ROLE_LABEL[role].toLowerCase()}</strong>?
      </p>
      {role === 'member' && (
        <p className="mt-1 text-xs text-muted">
          They will be signed out everywhere, and any authority to move funds is revoked.
        </p>
      )}

      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1">
          <span className="text-xs font-medium text-muted">Your authenticator code</span>
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 font-mono text-sm tracking-[0.3em] text-ink"
          />
        </label>
        <button
          type="submit"
          disabled={pending || code.length !== 6}
          className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-hair px-3 py-2 text-sm text-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MembersScreen() {
  const { orgId } = useParams({ from: '/o/$orgId/members' });

  const members = useListMembers(orgId);
  const invite = useInviteMember();
  const changeRole = useChangeMemberRole();
  const remove = useRemoveMember();

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [confirming, setConfirming] = useState<{ memberId: string; email: string; role: Role } | null>(
    null,
  );

  if (members.isPending) return <p className="p-8 text-sm text-muted">Loading…</p>;
  if (members.isError) return <p className="p-8 text-sm text-red-700">Could not load members.</p>;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-ink">People</h1>
        <p className="mt-1 text-sm text-muted">
          A role says what someone can do. Being trusted with funds is granted separately, and shown
          below — an invitation can never grant it.
        </p>
      </header>

      <div className="overflow-hidden rounded-xl border border-hair bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hair text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5 font-medium">Person</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Funds</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((member) => (
              <tr key={member.memberId} className="border-b border-hair/60 last:border-0">
                <td className="px-4 py-3 text-ink">{member.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={member.role}
                    onChange={(event) =>
                      setConfirming({
                        memberId: member.memberId,
                        email: member.email,
                        role: event.target.value as Role,
                      })
                    }
                    className="rounded-md border border-hair bg-white px-2 py-1 text-sm text-ink"
                  >
                    {(['owner', 'admin', 'member'] as const).map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  {member.hasMoneyAuthority ? (
                    // The one thing this table exists to surface.
                    <span className="rounded-full bg-secured/10 px-2 py-0.5 text-xs font-medium text-secured">
                      Can move funds
                    </span>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() =>
                      setConfirming({
                        memberId: member.memberId,
                        email: member.email,
                        role: member.role as Role,
                      })
                    }
                    className="text-xs font-medium text-muted hover:text-ink"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming && (
        <ConfirmRoleChange
          email={confirming.email}
          role={confirming.role}
          pending={changeRole.isPending || remove.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={(code) => {
            changeRole.mutate(
              {
                orgId,
                memberId: confirming.memberId,
                data: { role: confirming.role, code },
              },
              { onSuccess: () => setConfirming(null) },
            );
          }}
        />
      )}

      <Problem error={changeRole.error ?? remove.error} />

      <section className="mt-8 rounded-xl border border-hair bg-white p-5">
        <h2 className="text-sm font-semibold text-ink">Invite someone</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          You cannot invite above your own level. Whoever you invite starts with no ability to move
          money, whatever their role.
        </p>

        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate(
              { orgId, data: { email: inviteEmail, role: inviteRole } },
              { onSuccess: () => setInviteEmail('') },
            );
          }}
        >
          <label className="flex-1">
            <span className="text-xs font-medium text-muted">Email</span>
            <input
              required
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink"
            />
          </label>
          <label>
            <span className="text-xs font-medium text-muted">Role</span>
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as Role)}
              className="mt-1 block rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink"
            >
              {(['member', 'admin', 'owner'] as const).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={invite.isPending || inviteEmail === ''}
            className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </button>
        </form>

        <Problem error={invite.error} />
      </section>
    </div>
  );
}
