import type { ReactNode } from 'react';

/**
 * Page furniture shared by every screen, so a new one cannot invent its own
 * margins and drift out of alignment with the rest.
 */

export function Page({
  title,
  subtitle,
  actions,
  children,
  width = 'wide',
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'wide' | 'narrow';
}) {
  return (
    <div className={`mx-auto px-6 py-10 ${width === 'wide' ? 'max-w-5xl' : 'max-w-3xl'}`}>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm leading-relaxed text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string | undefined;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hair bg-white p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && (
              <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {!title && description && (
        <p className="mb-3 text-xs leading-relaxed text-muted">{description}</p>
      )}
      {children}
    </section>
  );
}

/**
 * An empty state that says what to DO, never just that there is nothing.
 *
 * `hint` is required for that reason: "No campaigns" leaves somebody stuck,
 * and a screen that can be reached with nothing on it will be.
 */
export function Empty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-hair bg-white p-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted">{hint}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="p-8 text-sm text-muted">Loading {what}…</p>;
}

export function LoadFailed({ what }: { what: string }) {
  return (
    <div className="rounded-xl border border-hair bg-white p-8 text-center">
      <p className="text-sm font-medium text-ink">Could not load {what}</p>
      <p className="mt-1 text-sm text-muted">
        Nothing has changed. Refresh, and if it keeps happening tell us.
      </p>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'mt-1 w-full rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink placeholder:text-muted';

/**
 * For a filter control that should size to its content.
 *
 * Deliberately a separate constant rather than `${inputClass} w-auto`: both
 * classes would be present and Tailwind resolves the conflict by CSS source
 * order, so `w-auto` loses to `w-full` and the filter quietly spans the page.
 */
export const selectClass =
  'rounded-lg border border-hair bg-white px-3 py-2 text-sm text-ink';

export const primaryButtonClass =
  'rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white disabled:opacity-40';

export const secondaryButtonClass =
  'rounded-lg border border-hair bg-white px-3 py-2 text-sm font-medium text-ink disabled:opacity-40';
