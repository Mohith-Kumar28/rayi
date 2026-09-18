/**
 * Deny-by-default allowlist for the Better Auth mount.
 *
 * **Why this file exists.** Better Auth is mounted as a catch-all
 * (`fastify.all('/api/auth/*')`) whose handler serves and returns *before* the
 * Nest guard chain runs. `AuthGuard` and `PermissionGuard` never see these
 * requests. Neither does the route-coverage test, which enumerates Nest routes —
 * and these are not Nest routes.
 *
 * The version in use exposes **42 endpoints** through that mount. Among them:
 * `/update-user`, `/change-email`, `/delete-user`, `/two-factor/disable`,
 * `/revoke-sessions`, `/link-social`, `/unlink-account`. Every one is a
 * security-relevant mutation with no MFA, no step-up, no audit row and no
 * authorization check of ours. An attacker with a session cookie reaches all of
 * them, and so does a brand member with no permissions at all.
 *
 * So the mount serves **only** what is listed here and 404s everything else.
 * Deny-by-default, exactly like `PermissionGuard`, because a dependency upgrade
 * that adds an endpoint must not silently add an attack surface.
 *
 * **404, not 403.** A 403 confirms the endpoint exists and is merely blocked,
 * which tells an attacker which version and which plugins are installed. A 404
 * is indistinguishable from "this software does not have that feature".
 *
 * Every entry carries the reason it is open. Adding one is a decision a reviewer
 * should have to read.
 */

export interface AllowedAuthRoute {
  /** Better Auth's own path, relative to the mount. `:param` segments are matched. */
  readonly path: string;
  readonly methods: readonly ('GET' | 'POST')[];
  /** Why this endpoint is reachable from the internet. */
  readonly why: string;
}

export const ALLOWED_AUTH_ROUTES: readonly AllowedAuthRoute[] = [
  {
    path: '/get-session',
    methods: ['GET', 'POST'],
    why: 'Every authenticated request resolves the session through this. Read-only.',
  },
  {
    path: '/sign-out',
    methods: ['POST'],
    why: 'Ending your own session must always be possible, and cannot be made worse by abuse.',
  },

  // ---- Sign-in: magic link only ------------------------------------------
  //
  // `emailAndPassword` is disabled, which removes the precondition for
  // GHSA-qq9h-g4jm-xgf3 (pre-account-hijacking) globally in one line. The
  // password endpoints are ALSO excluded here rather than relying on that flag
  // alone: a config regression would quietly re-expose them, and two independent
  // mechanisms saying the same thing is the point of the whole design.
  {
    path: '/sign-in/magic-link',
    methods: ['POST'],
    why: 'The only sign-in method. Rate limited; `disableSignUp` means it cannot create accounts.',
  },
  {
    path: '/magic-link/verify',
    methods: ['GET'],
    why: 'The redemption link from the email. Must be reachable unauthenticated.',
  },

  // ---- Second factor ------------------------------------------------------
  //
  // Verification is open; ENROLMENT and especially DISABLING are not. Turning
  // off someone’s second factor is a security-state change that belongs behind
  // step-up and an audit row, i.e. behind a Rayi controller.
  {
    path: '/two-factor/verify-totp',
    methods: ['POST'],
    why: 'Completing a sign-in challenge. Presenting a factor cannot weaken the account.',
  },
  {
    path: '/two-factor/verify-otp',
    methods: ['POST'],
    why: 'Same, for the emailed OTP path.',
  },
  {
    path: '/two-factor/verify-backup-code',
    methods: ['POST'],
    why: 'Recovery when the authenticator is lost. Single-use codes.',
  },
  {
    path: '/two-factor/send-otp',
    methods: ['POST'],
    why: 'Delivers the challenge for the above. Rate limited.',
  },

  // ---- Liveness -----------------------------------------------------------
  {
    path: '/ok',
    methods: ['GET'],
    why: 'Better Auth liveness. Returns no data about any user.',
  },
  {
    path: '/error',
    methods: ['GET'],
    why: 'The redirect target for auth errors. A static page.',
  },
];

/**
 * Everything the mount will NOT serve, with what replaces it.
 *
 * Not used at runtime — the allowlist above is the control. This exists so the
 * blocked surface is reviewable in one place, and so a future change that opens
 * one of these has to delete the sentence explaining why it was closed.
 */
export const BLOCKED_AUTH_ROUTES: Readonly<Record<string, string>> = {
  '/sign-in/email': 'Passwords are disabled. Sign in with a magic link.',
  '/sign-in/username': 'Passwords are disabled.',
  '/sign-up/email': 'Accounts are created by invitation, through a Rayi controller.',
  '/change-password': 'Passwords are disabled.',
  '/request-password-reset': 'Passwords are disabled.',
  '/reset-password': 'Passwords are disabled.',
  '/reset-password/:token': 'Passwords are disabled.',
  '/verify-password': 'Passwords are disabled.',
  '/update-user':
    'Profile changes go through a Rayi controller so they carry an audit row. Better Auth would let any session mutate the user unchecked.',
  '/change-email':
    'Changing the address that receives magic links is an account-takeover primitive. Needs step-up and notification to the OLD address.',
  '/delete-user': 'Account deletion needs a Rayi flow: outstanding balances, 1099 retention, holds.',
  '/delete-user/callback': 'Same.',
  '/two-factor/enable':
    'Enrolment is a security-state change and belongs behind step-up with an audit row.',
  '/two-factor/disable':
    'REMOVING a second factor, reachable with only a session cookie, is the single worst endpoint in the default surface.',
  '/two-factor/get-totp-uri': 'Exposes the TOTP secret to anyone holding a session.',
  '/two-factor/generate-backup-codes': 'Minting new recovery codes bypasses the existing factor.',
  '/list-sessions': 'Session management belongs in a Rayi surface that can audit it.',
  '/revoke-session': 'Same.',
  '/revoke-sessions': 'Same.',
  '/revoke-other-sessions': 'Same.',
  '/list-accounts': 'Discloses linked identity providers.',
  '/account-info': 'Same.',
  '/link-social':
    'Linking an attacker-controlled identity provider to a victim account is an account-takeover primitive.',
  '/unlink-account': 'Same, in reverse.',
  '/sign-in/social': 'No social sign-in is offered.',
  '/callback/:id': 'No social sign-in is offered.',
  '/get-access-token': 'No OAuth client flows are offered.',
  '/refresh-token': 'Same.',
  '/verify-email': 'Email verification happens through the invitation flow.',
  '/send-verification-email': 'Same.',
  '/update-session': 'Session contents are server-owned.',
  '/is-username-available': 'A username enumeration oracle.',
};

/** `/sign-in/magic-link` → `^/sign-in/magic-link$`; `:param` matches one segment. */
function toPattern(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

const COMPILED = ALLOWED_AUTH_ROUTES.map((route) => ({
  pattern: toPattern(route.path),
  methods: new Set<string>(route.methods),
}));

/**
 * Whether the mount should serve this request.
 *
 * `path` is relative to the mount and must already have its query string
 * removed. The METHOD is checked too: an endpoint open for GET is not thereby
 * open for POST, and several Better Auth handlers behave differently per method.
 */
export function isAllowedAuthRoute(method: string, path: string): boolean {
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const upper = method.toUpperCase();
  return COMPILED.some((route) => route.methods.has(upper) && route.pattern.test(normalised));
}

/**
 * The mount's actual decision, given a raw request URL.
 *
 * Extracted from the route handler so it can be tested with real URLs. The
 * handler then has no logic of its own to get wrong — and the cases that would
 * have been got wrong are exactly these: a query string appended to a blocked
 * path, a `..` segment, a path that only looks like it is under the mount.
 */
export function shouldServeAuthRequest(
  basePath: string,
  method: string,
  rawUrl: string,
): boolean {
  let pathname: string;
  try {
    // A base is required because `rawUrl` is origin-relative. The origin itself
    // is irrelevant here and is never used.
    pathname = new URL(rawUrl, 'http://placeholder.invalid').pathname;
  } catch {
    // An unparseable URL is not something to guess about.
    return false;
  }

  // `%2e%2e` and friends are already decoded by URL parsing, so a traversal
  // attempt arrives here as literal `..` and simply fails to match any pattern.
  if (!pathname.startsWith(`${basePath}/`) && pathname !== basePath) return false;

  const subPath = pathname.slice(basePath.length) || '/';
  return isAllowedAuthRoute(method, subPath);
}
