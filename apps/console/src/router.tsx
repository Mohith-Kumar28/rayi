import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { FundsScreen } from './routes/funds';
import { MembersScreen } from './routes/members';
import { SecurityScreen } from './routes/security';
import { MOCK_IDS } from '@rayi/api-client/mocks';

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-full bg-canvas">
      <header className="border-b border-hair bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-baseline gap-6">
            <span className="text-sm font-semibold tracking-tight text-ink">Rayi</span>
            <Nav />
          </div>
          <ScenarioSwitcher />
        </div>
      </header>
      <Outlet />
    </div>
  ),
});

/**
 * The three surfaces that exist so far.
 *
 * `orgId` is in the path on every tenant route — never read from the session,
 * because that is shared mutable state across tabs and an agency operator with
 * two clients open would act against the wrong brand.
 */
function Nav() {
  const linkClass = 'text-sm text-muted hover:text-ink';
  const activeClass = 'text-sm font-medium text-ink';

  return (
    <nav className="flex items-center gap-4">
      <Link
        to="/o/$orgId/funds"
        params={{ orgId: MOCK_IDS.ORG_ID }}
        className={linkClass}
        activeProps={{ className: activeClass }}
      >
        Funds
      </Link>
      <Link
        to="/o/$orgId/members"
        params={{ orgId: MOCK_IDS.ORG_ID }}
        className={linkClass}
        activeProps={{ className: activeClass }}
      >
        People
      </Link>
      <Link to="/me/security" className={linkClass} activeProps={{ className: activeClass }}>
        Security
      </Link>
    </nav>
  );
}

/** Dev-only affordance so the mocked failure paths are one click away. */
function ScenarioSwitcher() {
  return (
    <select
      defaultValue={globalThis.__rayiScenario ?? 'default'}
      onChange={(event) => {
        globalThis.__rayiScenario = event.target.value as never;
        globalThis.location.reload();
      }}
      className="rounded-md border border-hair bg-white px-2 py-1 text-xs text-muted"
      aria-label="Mock scenario"
    >
      <option value="default">default</option>
      <option value="insufficient-funds">insufficient funds</option>
      <option value="step-up-required">step-up required</option>
      <option value="idempotency-conflict">idempotency conflict</option>
      <option value="empty">empty state</option>
    </select>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/o/$orgId/funds', params: { orgId: MOCK_IDS.ORG_ID } });
  },
});

const fundsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/funds',
  component: FundsScreen,
});

const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/members',
  component: MembersScreen,
});

/**
 * Not org-scoped: the resource is the caller. Matches the API, where these are
 * `access: { kind: 'self' }` and carry no `{orgId}` — putting one in the path
 * would mean authorising the request against something unrelated to what it
 * touches.
 */
const securityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/security',
  component: SecurityScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  fundsRoute,
  membersRoute,
  securityRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
