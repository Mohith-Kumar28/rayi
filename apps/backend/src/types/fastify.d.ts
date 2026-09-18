import type { Auth } from 'better-auth/auth';

type BetterAuthSession = Awaited<ReturnType<Auth['api']['getSession']>>;

/**
 * Declaration merging for the properties the auth guard attaches to a request.
 *
 * The inherited code wrote `request['session'] = session`, which under
 * `noImplicitAny` is an error and, worse, gives every downstream reader `any` —
 * so a typo like `req.sesion` would compile and be `undefined` at runtime.
 * Declaring them here makes the attachment typed and the readers checked.
 */
declare module 'fastify' {
  interface FastifyRequest {
    session?: BetterAuthSession;
    /** Attached for Sentry's user context. */
    user?: BetterAuthSession extends { user: infer U } ? U | null : unknown;
  }
}

declare module 'socket.io' {
  interface Socket {
    session?: BetterAuthSession;
  }
}

export {};
