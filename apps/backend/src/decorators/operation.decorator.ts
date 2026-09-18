import { applyDecorators, Delete, Get, Patch, Post, Put, SetMetadata } from '@nestjs/common';
import { ALL_OPERATIONS, type Access, type OperationDefinition } from '@rayi/contracts';

/**
 * `@Operation('allocateBudget')` — the only way a money-bearing route is declared.
 *
 * It reads the operation out of the shared manifest in `@rayi/contracts` and
 * wires the HTTP method, the path and the authorization metadata from that one
 * entry. A handler therefore cannot be mounted at a path the published OpenAPI
 * document does not describe, and cannot be reachable without declaring who may
 * call it — `PermissionGuard` refuses anything carrying no access metadata.
 *
 * This is deliberately stricter than the boilerplate's `@Public()` /
 * `@ApiOperation()` pairing, which describes a route's *intent*. The manifest
 * describes its *contract*, and the handler is wired from it, so the server and
 * the generated client cannot drift.
 *
 * Controllers using `@Operation` take NO path prefix: the manifest holds the
 * whole path, so there is exactly one place to read to know what a URL maps to.
 */

export const OPERATION_ID = 'rayi:operationId';
export const OPERATION_ACCESS = 'rayi:access';

const METHOD_DECORATORS = {
  get: Get,
  post: Post,
  patch: Patch,
  put: Put,
  delete: Delete,
} as const;

const OPERATIONS_BY_ID = new Map<string, OperationDefinition>(
  ALL_OPERATIONS.map((operation) => [operation.operationId, operation]),
);

/** OpenAPI writes `{orgId}`; Nest and Fastify want `:orgId`. */
export function toNestPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ':$1');
}

export function getOperation(operationId: string): OperationDefinition {
  const operation = OPERATIONS_BY_ID.get(operationId);
  if (!operation) {
    throw new Error(
      `Unknown operationId "${operationId}". Add it to the manifest in @rayi/contracts first — ` +
        `a route absent from the manifest cannot appear in the OpenAPI document, so the generated ` +
        `client would have no way to call it.`,
    );
  }
  return operation;
}

export function Operation(operationId: string): MethodDecorator {
  const operation = getOperation(operationId);
  const method = METHOD_DECORATORS[operation.method];

  return applyDecorators(
    method(toNestPath(operation.path)),
    SetMetadata(OPERATION_ID, operationId),
    SetMetadata(OPERATION_ACCESS, operation.access satisfies Access),
  );
}
