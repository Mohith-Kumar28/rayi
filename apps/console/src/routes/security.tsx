import { useState } from 'react';
import {
  ApiError,
  useDisableTwoFactor,
  useListMyActivity,
  useListMySessions,
  useRequestEmailChange,
  useRevokeMyOtherSessions,
  useRevokeMySession,
} from '@rayi/api-client';

/**
 * Account security.
 *
 * Every action here needed a Nest route built for it, because Better Auth's
 * equivalents are blocked at the mount — they serve before the guard chain runs,
 * with no MFA, no audit row and no rate limit of ours.
 *
 * The screen's job is to make two things obvious that a list of settings usually
 * does not: which session is the one you are using, and that a code from your
 * authenticator is required before anything that could take the account over.
 */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-hair bg-white p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One consistent place for a server error, so no screen invents its own. */
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
 * The six-digit input.
 *
 * `inputMode="numeric"` and `autoComplete="one-time-code"` so a phone shows the
 * number pad and offers the code from the notification — small, and the
 * difference between a step-up people complete and one they abandon.
 */
function CodeInput({
  value,
  onChange,
  label = 'Authenticator code',
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        placeholder="000000"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
        className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 font-mono text-sm tracking-[0.3em] text-ink"
      />
    </label>
  );
}

function Sessions() {
  const sessions = useListMySessions();
  const revokeOne = useRevokeMySession();
  const revokeOthers = useRevokeMyOtherSessions();

  if (sessions.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (sessions.isError) return <p className="text-sm text-red-700">Could not load sessions.</p>;

  const rows = sessions.data.sessions;
  const others = rows.filter((session) => !session.current);

  return (
    <>
      <ul className="divide-y divide-hair overflow-hidden rounded-lg border border-hair">
        {rows.map((session) => (
          <li key={session.sessionId} className="flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-ink">
                  {session.userAgent ?? 'Unknown device'}
                </span>
                {session.current && (
                  // Marked, not hidden. The list is useless if you cannot tell
                  // which one you are about to sign yourself out of.
                  <span className="shrink-0 rounded-full bg-secured/10 px-2 py-0.5 text-[10px] font-medium text-secured">
                    This device
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {session.ipAddress ?? 'no address'} · since{' '}
                {new Date(session.createdAt).toLocaleDateString('en-US', {
                  day: 'numeric',
                  month: 'short',
                })}
              </div>
            </div>

            {!session.current && (
              <button
                type="button"
                onClick={() => revokeOne.mutate({ sessionId: session.sessionId })}
                disabled={revokeOne.isPending}
                className="shrink-0 rounded-lg border border-hair px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>

      {others.length > 0 && (
        <button
          type="button"
          onClick={() => revokeOthers.mutate(undefined)}
          disabled={revokeOthers.isPending}
          className="mt-3 w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {revokeOthers.isPending
            ? 'Signing out…'
            : `Sign out everywhere else (${others.length})`}
        </button>
      )}

      <Problem error={revokeOne.error ?? revokeOthers.error} />
    </>
  );
}

function EmailChange() {
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const request = useRequestEmailChange();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        request.mutate({ data: { newEmail, code } });
      }}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted">New email address</span>
        <input
          required
          type="email"
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
          className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink"
        />
      </label>

      <div className="mt-3">
        <CodeInput value={code} onChange={setCode} />
      </div>

      <button
        type="submit"
        disabled={request.isPending || code.length !== 6 || newEmail === ''}
        className="mt-4 w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {request.isPending ? 'Sending…' : 'Send confirmation'}
      </button>

      {request.isSuccess && (
        <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          Check the new address for a confirmation link. Nothing has changed yet — and we have told
          your current address, so you can stop this if it was not you.
        </p>
      )}

      <Problem error={request.error} />
    </form>
  );
}

function TwoFactor() {
  const [code, setCode] = useState('');
  const disable = useDisableTwoFactor();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        disable.mutate({ data: { code } });
      }}
    >
      <CodeInput value={code} onChange={setCode} label="Code from the app you are removing" />

      <button
        type="submit"
        disabled={disable.isPending || code.length !== 6}
        className="mt-4 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-40"
      >
        {disable.isPending ? 'Removing…' : 'Remove authenticator app'}
      </button>

      <Problem error={disable.error} />
    </form>
  );
}

function Activity() {
  const activity = useListMyActivity();

  if (activity.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (activity.isError) return <p className="text-sm text-red-700">Could not load activity.</p>;

  if (activity.data.events.length === 0) {
    return <p className="text-sm text-muted">Nothing recorded yet.</p>;
  }

  return (
    <ul className="divide-y divide-hair overflow-hidden rounded-lg border border-hair">
      {activity.data.events.map((event) => (
        <li key={event.id} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <span className="font-mono text-xs text-ink">{event.action}</span>
          <span className="shrink-0 text-xs text-muted">
            {event.ipAddress ?? '—'} ·{' '}
            {new Date(event.occurredAt).toLocaleString('en-US', {
              day: 'numeric',
              month: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function SecurityScreen() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Security</h1>
        <p className="mt-1 text-sm text-muted">
          Rayi will never ask you for a code by email, phone or chat. Anyone who does is not us.
        </p>
      </header>

      <div className="space-y-4">
        <Section
          title="Where you are signed in"
          description="Sign out a device you do not recognise. This does not need a code — ending a session can only ever make the account safer."
        >
          <Sessions />
        </Section>

        <Section
          title="Email address"
          description="This is where sign-in links go, so changing it needs a code — and we tell your current address first, with a link to stop it."
        >
          <EmailChange />
        </Section>

        <Section
          title="Authenticator app"
          description="Removing it needs a code from the app itself, so someone holding only your session cannot take it away."
        >
          <TwoFactor />
        </Section>

        <Section
          title="Recent activity"
          description="Everything recorded against your account. If something here was not you, sign out everywhere and tell us."
        >
          <Activity />
        </Section>
      </div>
    </div>
  );
}
