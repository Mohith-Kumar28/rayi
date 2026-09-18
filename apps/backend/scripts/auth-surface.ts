/**
 * Enumerates every HTTP endpoint Better Auth exposes, and commits the list.
 *
 * Better Auth is mounted as a catch-all, so a new endpoint in a patch release
 * becomes internet-reachable the moment the lockfile changes — with no code
 * review of ours anywhere in the path. This snapshot turns that into a failing
 * CI step whose diff is a list of the endpoints someone now has to decide about.
 *
 * Same pattern as the OpenAPI drift gate, and for the same reason: an artifact
 * in the repo is reviewable, and a check that regenerates it is the only thing
 * that keeps it true.
 *
 *   pnpm auth:surface           regenerate the snapshot
 *   pnpm verify:auth-surface    fail if it no longer matches the library
 *
 * Run through `tsx` rather than jest because Better Auth is ESM-only and the
 * backend's jest runtime is CommonJS. The allowlist LOGIC is unit-tested in
 * `src/auth/auth-route-allowlist.spec.ts` against this committed snapshot, which
 * keeps the fast tests free of an ESM dependency.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { betterAuth } from 'better-auth';
import { magicLink, twoFactor, username } from 'better-auth/plugins';

const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'auth', 'auth-surface.snapshot.json');

interface Endpoint {
  path: string;
  methods: string[];
}

function surface(): Endpoint[] {
  // The same plugin set as src/config/auth/better-auth.config.ts.
  //
  // `openAPI()` is deliberately absent: it is registered only outside
  // production. Leaving it out means its routes never enter the snapshot, so
  // they can never be quietly allowlisted — and the allowlist denies them
  // anyway, in every environment.
  const auth = betterAuth({
    secret: 'snapshot-only-secret-long-enough-for-better-auth',
    baseURL: 'http://localhost',
    plugins: [username(), magicLink({ sendMagicLink: async () => {} }), twoFactor()],
    emailAndPassword: { enabled: false },
  });

  const endpoints: Endpoint[] = [];

  for (const value of Object.values(auth.api)) {
    if (typeof value !== 'function') continue;
    const endpoint = value as unknown as {
      path?: string;
      options?: { method?: string | string[] };
    };
    if (!endpoint.path) continue;

    const method = endpoint.options?.method;
    endpoints.push({
      path: endpoint.path,
      methods: (Array.isArray(method) ? method : [method ?? 'POST']).map((m) => m.toUpperCase()).sort(),
    });
  }

  // Deduplicate and sort, so the committed file is stable across runs and the
  // diff on an upgrade shows only what genuinely changed.
  const byPath = new Map<string, Set<string>>();
  for (const endpoint of endpoints) {
    const methods = byPath.get(endpoint.path) ?? new Set<string>();
    for (const method of endpoint.methods) methods.add(method);
    byPath.set(endpoint.path, methods);
  }

  return [...byPath.entries()]
    .map(([path, methods]) => ({ path, methods: [...methods].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function main(): void {
  const current = JSON.stringify(surface(), null, 2) + '\n';
  const check = process.argv.includes('--check');

  if (!check) {
    writeFileSync(SNAPSHOT_PATH, current, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`Wrote ${SNAPSHOT_PATH}`);
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    // eslint-disable-next-line no-console
    console.error('No auth surface snapshot committed. Run: pnpm auth:surface');
    process.exit(1);
  }

  const committed = readFileSync(SNAPSHOT_PATH, 'utf8');
  if (committed !== current) {
    // eslint-disable-next-line no-console
    console.error(
      'The set of internet-reachable Better Auth endpoints has CHANGED.\n' +
        'This is not a broken test. Read every added path and decide whether it belongs in\n' +
        "ALLOWED_AUTH_ROUTES or BLOCKED_AUTH_ROUTES in src/auth/auth-route-allowlist.ts,\n" +
        'then regenerate with: pnpm auth:surface',
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Auth surface matches the snapshot (${surface().length} endpoints).`);
}

main();
