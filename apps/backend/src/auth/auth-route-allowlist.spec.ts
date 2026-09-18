import {
  ALLOWED_AUTH_ROUTES,
  BLOCKED_AUTH_ROUTES,
  isAllowedAuthRoute,
  shouldServeAuthRequest,
} from './auth-route-allowlist';
import SNAPSHOT from './auth-surface.snapshot.json';

/**
 * The allowlist, checked against the committed snapshot of what Better Auth
 * actually serves.
 *
 * Two different failures are guarded, in two places:
 *
 *   1. A **dependency upgrade adds an endpoint.** Better Auth mounts as a
 *      catch-all, so a new endpoint in a patch release becomes internet-reachable
 *      the moment the lockfile changes, with no code review of ours anywhere in
 *      the path. `pnpm verify:auth-surface` regenerates the snapshot from the
 *      installed library and fails CI on a diff. It lives in a script rather
 *      than here because Better Auth is ESM-only and this jest runtime is CJS.
 *
 *   2. An entry in the allowlist **stops matching a real endpoint**, through a
 *      rename upstream or a typo here. A deny-by-default list with a typo denies
 *      something it meant to permit, and the symptom is "sign-in is broken" with
 *      nothing pointing at this file. That is what these tests catch.
 */

const KNOWN_AUTH_SURFACE: readonly string[] = (
  SNAPSHOT as ReadonlyArray<{ path: string; methods: string[] }>
).map((endpoint) => endpoint.path);

describe('the Better Auth surface is what we reviewed', () => {
  it('has a snapshot at all, with the endpoints we expect to exist', () => {
    // A snapshot that silently emptied would make every assertion below vacuous.
    expect(KNOWN_AUTH_SURFACE.length).toBeGreaterThan(30);
    expect(KNOWN_AUTH_SURFACE).toContain('/get-session');
    expect(KNOWN_AUTH_SURFACE).toContain('/two-factor/disable');
  });

  it('matches every snapshot path with the declared method', () => {
    // The snapshot records methods too, so an allowlist entry that permits only
    // POST on a GET-only endpoint is a silent denial.
    const byPath = new Map(
      (SNAPSHOT as ReadonlyArray<{ path: string; methods: string[] }>).map((endpoint) => [
        endpoint.path,
        endpoint.methods,
      ]),
    );

    // Collected rather than asserted one at a time, so a failure names every
    // mismatched route instead of only the first.
    const mismatches: string[] = [];
    for (const route of ALLOWED_AUTH_ROUTES) {
      const actual = byPath.get(route.path);
      if (!actual) {
        mismatches.push(`${route.path} is not in the snapshot`);
        continue;
      }
      for (const method of route.methods) {
        if (!actual.includes(method)) {
          mismatches.push(`${route.path} does not serve ${method} (serves ${actual.join(', ')})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('accounts for every endpoint as either allowed or explicitly blocked', () => {
    const decided = new Set<string>([
      ...ALLOWED_AUTH_ROUTES.map((route) => route.path),
      ...Object.keys(BLOCKED_AUTH_ROUTES),
    ]);

    const undecided = KNOWN_AUTH_SURFACE.filter((path) => !decided.has(path));
    // Not merely tidiness: an endpoint nobody decided about is one nobody read.
    expect(undecided).toEqual([]);
  });

  it('never both allows and blocks the same path', () => {
    const allowed = ALLOWED_AUTH_ROUTES.map((route) => route.path);
    const contradictions = allowed.filter((path) => path in BLOCKED_AUTH_ROUTES);
    expect(contradictions).toEqual([]);
  });

  it('allows nothing that the library does not actually serve', () => {
    // A typo in an allowlist entry denies something it meant to permit, and the
    // symptom is "sign-in is broken" with nothing pointing here.
    const real = new Set<string>(KNOWN_AUTH_SURFACE);
    const phantom = ALLOWED_AUTH_ROUTES.filter((route) => !real.has(route.path));
    expect(phantom.map((route) => route.path)).toEqual([]);
  });

  it('gives every allowed route a stated reason', () => {
    for (const route of ALLOWED_AUTH_ROUTES) {
      expect(route.why.length).toBeGreaterThan(20);
      expect(route.methods.length).toBeGreaterThan(0);
    }
  });
});

describe('the matcher denies by default', () => {
  it('allows the session endpoint on both its methods', () => {
    expect(isAllowedAuthRoute('GET', '/get-session')).toBe(true);
    expect(isAllowedAuthRoute('POST', '/get-session')).toBe(true);
  });

  it.each([
    ['disabling someone’s second factor', 'POST', '/two-factor/disable'],
    ['reading the TOTP secret', 'POST', '/two-factor/get-totp-uri'],
    ['changing the address that receives magic links', 'POST', '/change-email'],
    ['mutating the user unchecked', 'POST', '/update-user'],
    ['deleting the account', 'POST', '/delete-user'],
    ['linking an attacker-controlled identity', 'POST', '/link-social'],
    ['revoking sessions', 'POST', '/revoke-sessions'],
    ['password sign-in', 'POST', '/sign-in/email'],
    ['self-service sign-up', 'POST', '/sign-up/email'],
    ['username enumeration', 'POST', '/is-username-available'],
    ['listing linked accounts', 'GET', '/list-accounts'],
  ])('blocks %s', (_label, method, path) => {
    expect(isAllowedAuthRoute(method, path)).toBe(false);
  });

  it('blocks a path nobody has ever heard of, which is the point', () => {
    expect(isAllowedAuthRoute('POST', '/some-future-plugin/do-anything')).toBe(false);
    expect(isAllowedAuthRoute('GET', '/reference')).toBe(false);
    expect(isAllowedAuthRoute('GET', '/open-api/generate-schema')).toBe(false);
  });

  it('checks the METHOD, not just the path', () => {
    // Several Better Auth handlers behave differently per method, so an endpoint
    // open for GET is not thereby open for POST.
    expect(isAllowedAuthRoute('GET', '/magic-link/verify')).toBe(true);
    expect(isAllowedAuthRoute('POST', '/magic-link/verify')).toBe(false);
    expect(isAllowedAuthRoute('DELETE', '/get-session')).toBe(false);
    expect(isAllowedAuthRoute('PUT', '/sign-out')).toBe(false);
  });

  it('is not fooled by a trailing slash', () => {
    expect(isAllowedAuthRoute('POST', '/sign-out/')).toBe(true);
    expect(isAllowedAuthRoute('POST', '/two-factor/disable/')).toBe(false);
  });

  it('does not let a prefix match stand in for the whole path', () => {
    // `/sign-out-everything` must not be allowed by `/sign-out`. The patterns are
    // anchored at both ends; this is the test that proves it.
    expect(isAllowedAuthRoute('POST', '/sign-out-everything')).toBe(false);
    expect(isAllowedAuthRoute('POST', '/get-session-secrets')).toBe(false);
    expect(isAllowedAuthRoute('POST', '/x/sign-out')).toBe(false);
  });

  it('does not treat a regex metacharacter in the path as a wildcard', () => {
    // `.` in a pattern would otherwise match any character — `/sign-outX` would
    // pass. The compiler escapes them.
    expect(isAllowedAuthRoute('POST', '/sign.out')).toBe(false);
    expect(isAllowedAuthRoute('GET', '/ok!')).toBe(false);
  });
});

describe('the decision the mount actually makes, from a raw URL', () => {
  const MOUNT = '/api/auth';
  const serve = (method: string, url: string) => shouldServeAuthRequest(MOUNT, method, url);

  it('serves an allowed route under the mount', () => {
    expect(serve('GET', '/api/auth/get-session')).toBe(true);
    expect(serve('POST', '/api/auth/sign-in/magic-link')).toBe(true);
  });

  it('is not fooled by a query string on a blocked path', () => {
    // The raw request URL carries the query. Slicing the path off a string that
    // still contains `?token=...` is the obvious bug here, and it would leave
    // every blocked endpoint reachable by appending a parameter.
    expect(serve('POST', '/api/auth/two-factor/disable?x=1')).toBe(false);
    expect(serve('POST', '/api/auth/update-user?redirect=/')).toBe(false);
  });

  it('keeps serving an allowed route that carries a query string', () => {
    expect(serve('GET', '/api/auth/magic-link/verify?token=abc&callbackURL=/')).toBe(true);
  });

  it('refuses a path outside the mount', () => {
    // Fastify would not route these here, but the check must not depend on that:
    // a mount path change or a proxy rewrite should not silently open anything.
    expect(serve('GET', '/get-session')).toBe(false);
    expect(serve('GET', '/api/authx/get-session')).toBe(false);
    expect(serve('GET', '/other/api/auth/get-session')).toBe(false);
  });

  it('refuses a traversal attempt rather than resolving it into an allowed path', () => {
    expect(serve('POST', '/api/auth/two-factor/../get-session')).toBe(true); // URL normalises it
    expect(serve('POST', '/api/auth/../admin')).toBe(false);
    expect(serve('POST', '/api/auth/%2e%2e/admin')).toBe(false);
  });

  it('refuses an unparseable URL rather than guessing', () => {
    expect(serve('GET', '')).toBe(false);
    expect(serve('GET', '::::')).toBe(false);
  });

  it('refuses the bare mount itself', () => {
    expect(serve('GET', '/api/auth')).toBe(false);
    expect(serve('GET', '/api/auth/')).toBe(false);
  });
});
