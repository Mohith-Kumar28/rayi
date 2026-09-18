import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ApiError,
  useGetMyCreatorProfile,
  useGetMyPayoutDestination,
  useStartPayoutDestinationChange,
} from '@rayi/api-client';

/**
 * The creator's own account.
 *
 * **Changing where money goes is treated as a money action, not a setting.** It
 * needs a fresh security check, it routes through the payment provider's own
 * onboarding rather than accepting bank details here, it notifies the previous
 * contact details, and it pauses payouts for 72 hours afterwards.
 *
 * All four exist because this population is the one that RECEIVES the money and
 * has the weakest authentication: passwordless, often no second factor, and a
 * phone number US carriers may reassign after about 45 days. A hijacked session
 * that could silently rebind a bank account would be the end of the product's
 * trust story, so the hold is the recovery window and the screen says so.
 */
export function CreatorProfileScreen() {
  const profile = useGetMyCreatorProfile();
  const destination = useGetMyPayoutDestination();
  const start = useStartPayoutDestinationChange();
  const [code, setCode] = useState('');
  const [confirming, setConfirming] = useState(false);

  if (profile.isPending) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (profile.isError) return <p className="p-6 text-sm text-red-700">Could not load your account.</p>;

  const problem = start.error instanceof ApiError ? start.error.problem : null;

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <header className="mb-6">
        <Link to="/me" className="text-sm text-muted">
          ← Your work
        </Link>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-ink">Your account</h1>
        <p className="mt-1 text-sm text-muted">
          Rayi will never ask you for a code by email, phone or chat. Anyone who does is not us.
        </p>
      </header>

      <section className="rounded-xl border border-hair bg-white p-5">
        <h2 className="text-sm font-semibold text-ink">You</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Handle</dt>
            <dd className="text-ink">{profile.data.handle}</dd>
          </div>
          {profile.data.displayName && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Name</dt>
              <dd className="text-ink">{profile.data.displayName}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email</dt>
            <dd className="truncate text-ink">{profile.data.email}</dd>
          </div>
        </dl>
      </section>

      {/*
        Offered rather than nagged, and the reason given is the creator's own
        money rather than our policy. It becomes required for a rebind once
        enrolled, which is the point at which it protects something.
      */}
      {!profile.data.twoFactorEnabled && (
        <section className="mt-4 rounded-xl border border-hair bg-white p-5">
          <h2 className="text-sm font-semibold text-ink">Add a second step to sign in</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Right now anyone with access to your email can sign in as you. A second step means they
            cannot — and it is the single biggest thing protecting where your money goes.
          </p>
          <Link
            to="/me/security"
            className="mt-3 inline-block rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white"
          >
            Set it up
          </Link>
        </section>
      )}

      <section className="mt-4 rounded-xl border border-hair bg-white p-5">
        <h2 className="text-sm font-semibold text-ink">Where your money goes</h2>

        {destination.data?.last4 ? (
          <p className="mt-2 text-sm text-ink">
            {destination.data.bankName ?? 'Your bank'} ····{destination.data.last4}
            {destination.data.payoutsEnabled ? '' : ' · not verified yet'}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">No account set up yet.</p>
        )}

        {/*
          The active hold, said HERE and not only on the payouts screen.

          This is the page where somebody would change the account again, and
          changing twice inside a hold window is exactly the pattern an attacker
          produces. A creator who did not start the first change needs to see it
          at the moment they are looking at their bank details.
        */}
        {destination.data?.holdUntil &&
          new Date(destination.data.holdUntil) > new Date() && (
            <div className="mt-2 rounded-lg border border-hair bg-canvas p-3">
              <p className="text-sm text-ink">
                Payouts are paused until{' '}
                {new Date(destination.data.holdUntil).toLocaleDateString('en-US', {
                  day: 'numeric',
                  month: 'short',
                })}{' '}
                because these details changed recently.
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                <strong>If that was not you</strong>, do not change them again — use the stop link
                in the email we sent to your previous address, and it undoes the change.
              </p>
            </div>
          )}

        {destination.data && destination.data.pendingRequirements.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
            {destination.data.pendingRequirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        )}

        {start.data ? (
          <div className="mt-3 rounded-lg border border-hair bg-canvas p-3">
            <p className="text-sm text-ink">Continue with our payment provider to finish.</p>
            <a
              href={start.data.onboardingUrl}
              rel="noreferrer noopener"
              className="mt-2 inline-block rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white"
            >
              Continue
            </a>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              This link works once and expires in a few minutes.
            </p>
          </div>
        ) : confirming ? (
          <div className="mt-3 space-y-3">
            {/*
              What will happen, said BEFORE they start rather than discovered
              afterwards. A creator who does not know a change pauses payouts for
              three days reads the pause as the product being broken.
            */}
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-900">Before you change this</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-900">
                <li>Your payouts pause for 72 hours afterwards.</li>
                <li>We tell your current email and phone, with a link to stop it.</li>
                <li>You enter your bank details with our payment provider, never here.</li>
              </ul>
            </div>

            <label className="block">
              <span className="text-xs font-medium text-muted">Your authenticator code</span>
              <input
                className="mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 font-mono text-sm tracking-[0.3em] text-ink"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
              />
            </label>

            {problem && (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                <p className="font-medium text-amber-900">{problem.title}</p>
                {problem.detail && <p className="mt-1 text-amber-800">{problem.detail}</p>}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                disabled={start.isPending || code.length !== 6}
                onClick={() => start.mutate({ data: { code } })}
              >
                {start.isPending ? 'Starting…' : 'Continue'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-hair px-3 py-2 text-sm font-medium text-ink"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="mt-3 rounded-lg border border-hair px-3 py-2 text-sm font-medium text-ink"
            onClick={() => setConfirming(true)}
          >
            {destination.data?.last4 ? 'Change bank account' : 'Set up payouts'}
          </button>
        )}
      </section>
    </div>
  );
}
