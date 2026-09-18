import type { z } from 'zod';

/**
 * The operation manifest.
 *
 * ONE entry per endpoint, and it is the single source of truth for four things
 * that otherwise drift apart:
 *
 *   1. runtime request validation on the server
 *   2. response serialisation on the server
 *   3. the generated OpenAPI document
 *   4. the generated client and its mock handlers
 *
 * Nest's decorator-based Swagger describes a handler's *intent*; this describes
 * the handler's *contract*, and the handler is wired from it. A spec that does
 * not match the server is worse than no spec when a partner or an auditor is
 * reading it.
 *
 * Authorization metadata lives here too, so "which permission gates this route"
 * is reviewable in one file rather than scattered across controllers — and so
 * the route-coverage test can assert that every operation declares one.
 */

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

/**
 * `public` is deliberately spelled out rather than expressed as an absent
 * permission, so that forgetting to declare access is a type error rather than
 * an accidentally public endpoint.
 */
export type Access =
  | { readonly kind: 'public' }
  | {
      readonly kind: 'permission';
      /** e.g. `campaign:allocate`. Resolved against Rayi's own role_permission table. */
      readonly permission: string;
      /** Require a fresh authentication factor before this call. Money-moving actions set this. */
      readonly stepUp?: boolean;
      /** True when this operation can cause funds to move, directly or on a timer. */
      readonly movesMoney?: boolean;
    };

export interface OperationDefinition<
  TPath extends z.ZodType = z.ZodType,
  TQuery extends z.ZodType = z.ZodType,
  TBody extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  /** Stable identifier. Becomes the generated client's function name — never rename casually. */
  readonly operationId: string;
  readonly method: HttpMethod;
  /** OpenAPI-style path with `{param}` placeholders. */
  readonly path: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly access: Access;
  readonly pathParams?: TPath;
  readonly query?: TQuery;
  readonly body?: TBody;
  readonly successStatus: number;
  readonly response: TResponse;
  /** Error codes this operation can return, for documentation and client exhaustiveness. */
  readonly errors?: readonly string[];
}

export function defineOperation<
  TPath extends z.ZodType,
  TQuery extends z.ZodType,
  TBody extends z.ZodType,
  TResponse extends z.ZodType,
>(definition: OperationDefinition<TPath, TQuery, TBody, TResponse>): OperationDefinition<
  TPath,
  TQuery,
  TBody,
  TResponse
> {
  return definition;
}

/** Narrowing helper used by the guard and by the coverage tests. */
export function movesMoney(operation: OperationDefinition): boolean {
  return operation.access.kind === 'permission' && operation.access.movesMoney === true;
}
