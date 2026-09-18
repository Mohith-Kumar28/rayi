import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Link,
  Outlet,
  redirect,
  useMatchRoute,
} from '@tanstack/react-router';

import { MOCK_IDS, MOCK_SCENARIOS } from '@rayi/api-client/mocks';

import { FundsScreen } from './routes/funds';
import { MembersScreen } from './routes/members';
import { ReviewScreen } from './routes/review';
import { SecurityScreen } from './routes/security';

/**
 * One SPA, two populations, one origin.
 *
 * `app.rayi.com` serves both authed route trees — `/o/$orgId/*` for brands and
 * `/me/*` for creators. Because the API is same-origin there is no CORS, no
 * preflight, no `SameSite=None`, and `connect-src 'self'` is literally true.
 * That single decision removes an entire category of cookie and CSRF problems.
 *
 * **The creator tree is lazily loaded, and that is not an optimisation.** A
 * creator opens this on a phone, often on mobile data, to check one payout.
 * Shipping them the brand review queue, the funds screen and the members table
 * is a real cost paid by the population that can least afford it — and it is the
 * population that receives the money.
 */

const rootRoute = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const matchRoute = useMatchRoute();
  // The creator surface gets no brand chrome. It is a different product for a
  // different person, and a nav bar full of things they cannot use is noise on a
  // screen that has one job.
  const isCreator = Boolean(matchRoute({ to: '/me', fuzzy: true }));
  /*
   * Neither does the admin surface — and here it is a correctness point rather
   * than a taste one. A platform operator is not inside any tenant, so brand
   * nav links pointing at one particular organization say something false about
   * who they are and what they are looking at. In production this tree lives on
   * its own origin and could not render this chrome at all; until then the
   * layout says the same thing the deployment will.
   */
  const isAdmin = Boolean(matchRoute({ to: '/admin', fuzzy: true }));

  return (
    <div className="min-h-full bg-canvas">
      {isAdmin && (
        <header className="border-b border-hair bg-ink">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
            <div className="flex items-baseline gap-5">
              <span className="text-sm font-semibold tracking-tight text-white">Rayi</span>
              <AdminNav />
            </div>
            <ScenarioSwitcher dark />
          </div>
        </header>
      )}
      {!isCreator && !isAdmin && (
        <header className="border-b border-hair bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-3">
            <div className="flex min-w-0 items-baseline gap-6">
              <span className="text-sm font-semibold tracking-tight text-ink">Rayi</span>
              <BrandNav />
            </div>
            <ScenarioSwitcher />
          </div>
        </header>
      )}
      <Outlet />
    </div>
  );
}

/**
 * `orgId` is in the path on every tenant route — never read from the session.
 * That field is shared mutable state across tabs, so an agency operator with two
 * clients open would otherwise act against the wrong brand.
 */
function BrandNav() {
  const linkClass = 'text-sm text-muted hover:text-ink';
  const activeClass = 'text-sm font-medium text-ink';

  return (
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {(
        [
          // Ordered by how often a brand actually does the thing. Review is
          // first because it is the job; settings is last because it is not.
          ['/o/$orgId/review', 'Review'],
          ['/o/$orgId/campaigns', 'Campaigns'],
          ['/o/$orgId/deals', 'Deals'],
          ['/o/$orgId/creators', 'Creators'],
          ['/o/$orgId/funds', 'Funds'],
          ['/o/$orgId/workspaces', 'Workspaces'],
          ['/o/$orgId/members', 'People'],
          ['/o/$orgId/settings', 'Settings'],
        ] as const
      ).map(([to, label]) => (
        <Link
          key={to}
          to={to}
          params={{ orgId: MOCK_IDS.ORG_ID }}
          className={linkClass}
          activeProps={{ className: activeClass }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Platform staff navigation.
 *
 * Its own nav, on its own dark chrome, with no organization in any link — a
 * platform operator is inside no tenant, and a nav pointing at one particular
 * brand would say something false about who they are.
 */
function AdminNav() {
  const linkClass = 'text-sm text-white/60 hover:text-white';
  const activeClass = 'text-sm font-medium text-white';

  return (
    <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {(
        [
          ['/admin', 'Overview'],
          ['/admin/creators', 'Creators'],
          ['/admin/ops', 'Operations'],
          ['/admin/audit', 'Audit'],
        ] as const
      ).map(([to, label]) => (
        <Link
          key={to}
          to={to}
          className={linkClass}
          activeProps={{ className: activeClass }}
          activeOptions={{ exact: to === '/admin' }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Dev-only affordance so the mocked failure paths are one click away. */
function ScenarioSwitcher({ dark = false }: { dark?: boolean }) {
  return (
    <select
      defaultValue={globalThis.__rayiScenario ?? 'default'}
      onChange={(event) => {
        globalThis.__rayiScenario = event.target.value as never;
        globalThis.location.reload();
      }}
      className={`rounded-md border px-2 py-1 text-xs ${
        dark ? 'border-white/20 bg-white/10 text-white' : 'border-hair bg-white text-muted'
      }`}
      aria-label="Mock scenario"
    >
      {/* Read from the mock module rather than restated here, so a scenario
          added to the fixtures cannot be one nobody can reach. */}
      {MOCK_SCENARIOS.map((name) => (
        <option key={name} value={name}>
          {name.replace(/-/g, ' ')}
        </option>
      ))}
    </select>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    // The index is the REVIEW QUEUE, not a dashboard. The brand's job is
    // deciding on work; a dashboard is what you build when you do not know what
    // the job is.
    throw redirect({ to: '/o/$orgId/review', params: { orgId: MOCK_IDS.ORG_ID } });
  },
});

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/review',
  component: ReviewScreen,
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

const campaignsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/campaigns',
  component: lazyRouteComponent(() => import('./routes/campaigns'), 'CampaignsScreen'),
});

const campaignRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/campaigns/$campaignId',
  component: lazyRouteComponent(() => import('./routes/campaign'), 'CampaignScreen'),
});

const dealsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/deals',
  component: lazyRouteComponent(() => import('./routes/deals'), 'DealsScreen'),
});

const newDealRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Before `/deals/$dealId` in the tree, so "new" is never read as an id.
  path: '/o/$orgId/deals/new',
  component: lazyRouteComponent(() => import('./routes/deal-new'), 'NewDealScreen'),
});

const dealRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/deals/$dealId',
  component: lazyRouteComponent(() => import('./routes/deal'), 'DealScreen'),
});

const rosterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/creators',
  component: lazyRouteComponent(() => import('./routes/roster'), 'RosterScreen'),
});

const rosterCreatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/creators/$creatorId',
  component: lazyRouteComponent(() => import('./routes/roster-creator'), 'RosterCreatorScreen'),
});

const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/workspaces',
  component: lazyRouteComponent(() => import('./routes/workspaces'), 'WorkspacesScreen'),
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/workspaces/$workspaceId',
  component: lazyRouteComponent(() => import('./routes/workspace'), 'WorkspaceScreen'),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$orgId/settings',
  component: lazyRouteComponent(() => import('./routes/settings'), 'SettingsScreen'),
});

// ---------------------------------------------------------------------------
// Account — not org-scoped, because the resource is the caller
// ---------------------------------------------------------------------------

/**
 * Matches the API, where these are `access: { kind: 'self' }` and carry no
 * `{orgId}`. Putting one in the path would mean authorising the request against
 * something unrelated to what it touches.
 */
const securityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/security',
  component: SecurityScreen,
});

// ---------------------------------------------------------------------------
// Creator — lazily loaded
// ---------------------------------------------------------------------------

const creatorHomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me',
  component: lazyRouteComponent(() => import('./routes/creator/home'), 'CreatorHomeScreen'),
});

const creatorDealRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/deals/$dealId',
  component: lazyRouteComponent(() => import('./routes/creator/deal'), 'CreatorDealScreen'),
});

const creatorPayoutsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/payouts',
  component: lazyRouteComponent(() => import('./routes/creator/payouts'), 'CreatorPayoutsScreen'),
});

const creatorProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/me/profile',
  component: lazyRouteComponent(() => import('./routes/creator/profile'), 'CreatorProfileScreen'),
});

// ---------------------------------------------------------------------------
// Super admin — lazily loaded
// ---------------------------------------------------------------------------

/**
 * In PRODUCTION this belongs on its own origin (`admin.rayi.com`), so an XSS
 * anywhere in the brand or creator app cannot reach an admin session. It lives
 * here for now behind a lazy route, which keeps it out of every other visitor's
 * bundle but does NOT give it origin isolation — that is a deployment change,
 * and the roadmap says so rather than this comment pretending otherwise.
 */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('./routes/admin/overview'), 'AdminOverviewScreen'),
});

const adminBrandRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/brands/$brandId',
  component: lazyRouteComponent(() => import('./routes/admin/brand'), 'AdminBrandScreen'),
});

const adminCreatorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/creators',
  component: lazyRouteComponent(() => import('./routes/admin/creators'), 'AdminCreatorsScreen'),
});

const adminOpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/ops',
  component: lazyRouteComponent(() => import('./routes/admin/ops'), 'AdminOpsScreen'),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/audit',
  component: lazyRouteComponent(() => import('./routes/admin/audit'), 'AdminAuditScreen'),
});

const routeTree = rootRoute.addChildren([
  indexRoute,

  // Brand
  reviewRoute,
  fundsRoute,
  campaignsRoute,
  campaignRoute,
  newDealRoute,
  dealsRoute,
  dealRoute,
  rosterRoute,
  rosterCreatorRoute,
  workspacesRoute,
  workspaceRoute,
  membersRoute,
  settingsRoute,

  // Account
  securityRoute,

  // Creator
  creatorHomeRoute,
  creatorDealRoute,
  creatorPayoutsRoute,
  creatorProfileRoute,

  // Super admin
  adminRoute,
  adminBrandRoute,
  adminCreatorsRoute,
  adminOpsRoute,
  adminAuditRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
