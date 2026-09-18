import { ProblemSchema, type Problem } from '@rayi/contracts';

/**
 * The single HTTP entry point for the whole frontend.
 *
 * Deliberate choices:
 *
 *  - `credentials: 'same-origin'`. The API is served same-origin with the app
 *    via a CloudFront `/api/*` behaviour, so the session cookie is host-only
 *    (`__Host-` prefixed) and there is no CORS, no preflight, no `SameSite=None`
 *    and no CHIPS workaround. `connect-src 'self'` is then literally true.
 *
 *  - Every mutation sends `content-type: application/json`, which is not a
 *    CORS-simple type and therefore cannot skip preflight. Combined with the
 *    server rejecting any mutation whose `Origin` is not the exact app origin,
 *    that closes the same-site CSRF path from the public UGC origin — which
 *    renders creator-authored bios and is same-SITE with the app, so
 *    `SameSite=Lax` would happily attach the session cookie.
 *
 *  - A non-2xx response THROWS a typed `ApiError` carrying an RFC 9457 problem.
 *    Callers branch on a stable `code`, never on a message string. Returning a
 *    success-or-error union instead would make every call site responsible for
 *    remembering to check — and one forgotten check on a money path is a bug
 *    that renders as success.
 */

export class ApiError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get code(): Problem['code'] {
    return this.problem.code;
  }

  get status(): number {
    return this.problem.status;
  }

  /** Step-up challenges carry what to display. Never render an amount from client cache. */
  get challenge(): Problem['challenge'] {
    return this.problem.challenge;
  }
}

function fallbackProblem(status: number, requestId: string): Problem {
  return {
    type: 'about:blank',
    title: status >= 500 ? 'Something went wrong on our side' : 'Request failed',
    status,
    code: status >= 500 ? 'internal_error' : 'conflict',
    requestId,
  };
}

export const API_BASE_URL = '/api';

/** The config shape orval's generated client passes to a custom mutator. */
export interface RayiFetchConfig {
  url: string;
  method: string;
  params?: Record<string, unknown> | undefined;
  data?: unknown;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

export async function rayiFetch<TResponse>(config: RayiFetchConfig): Promise<TResponse> {
  const origin = globalThis.location?.origin ?? 'http://localhost';
  const target = new URL(`${API_BASE_URL}${config.url}`, origin);

  for (const [key, value] of Object.entries(config.params ?? {})) {
    if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
  }

  const hasBody = config.data !== undefined && config.data !== null;

  const response = await fetch(target.toString(), {
    method: config.method.toUpperCase(),
    credentials: 'same-origin',
    ...(config.signal ? { signal: config.signal } : {}),
    headers: {
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...config.headers,
    },
    ...(hasBody ? { body: JSON.stringify(config.data) } : {}),
  });

  const requestId = response.headers.get('x-request-id') ?? 'unknown';

  if (!response.ok) {
    let problem: Problem;
    try {
      problem = ProblemSchema.parse(await response.json());
    } catch {
      problem = fallbackProblem(response.status, requestId);
    }
    throw new ApiError(problem);
  }

  if (response.status === 204) return undefined as TResponse;
  return (await response.json()) as TResponse;
}
