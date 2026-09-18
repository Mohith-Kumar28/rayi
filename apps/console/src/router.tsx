import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';

import { FundsScreen } from './routes/funds';
import { MOCK_IDS } from '@rayi/api-client/mocks';

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-full bg-canvas">
      <header className="border-b border-hair bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold tracking-tight text-ink">Rayi</span>
          <ScenarioSwitcher />
        </div>
      </header>
      <Outlet />
    </div>
  ),
});

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

const routeTree = rootRoute.addChildren([indexRoute, fundsRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
