import { z } from 'zod';

import { ProblemSchema } from './errors.js';
import type { Access, OperationDefinition } from './operation.js';

/**
 * Emits an OpenAPI 3.1 document from the operation manifest.
 *
 * A pure function over the manifest — no Nest boot, no server start, no
 * database. That matters for two reasons: CI can verify the committed spec in
 * milliseconds, and the frontend can generate its client before a backend
 * exists at all.
 *
 * 3.1 rather than 3.0.3 because 3.1 *is* JSON Schema 2020-12, which is exactly
 * what Zod 4 emits natively. Targeting 3.0.3 would mean hand-translating the
 * dialect, and a translation layer between the schema that validates and the
 * schema that is published is precisely the drift this design exists to remove.
 */

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

type JsonObject = Record<string, unknown>;

function toSchema(schema: z.ZodType): JsonObject {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as JsonObject;
}

/** `{orgId}` in a path means a required path parameter; the manifest's schema types it. */
function pathParameters(operation: OperationDefinition): JsonObject[] {
  if (!operation.pathParams) return [];
  const schema = toSchema(operation.pathParams);
  const properties = (schema['properties'] ?? {}) as Record<string, JsonObject>;
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'path',
    required: true,
    schema: propertySchema,
    ...(propertySchema['description'] ? { description: propertySchema['description'] } : {}),
  }));
}

function queryParameters(operation: OperationDefinition): JsonObject[] {
  if (!operation.query) return [];
  const schema = toSchema(operation.query);
  const properties = (schema['properties'] ?? {}) as Record<string, JsonObject>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
    ...(propertySchema['description'] ? { description: propertySchema['description'] } : {}),
  }));
}

const PROBLEM_STATUS: Record<string, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  step_up_required: 403,
  not_found: 404,
  conflict: 409,
  idempotency_key_reused: 409,
  insufficient_unallocated_funds: 409,
  budget_envelope_exceeded: 409,
  daily_limit_exceeded: 409,
  deposit_not_settled: 409,
  organization_frozen: 409,
  rate_limited: 429,
  internal_error: 500,
};

function errorResponses(operation: OperationDefinition): JsonObject {
  const responses: JsonObject = {};
  const statuses = new Set<number>();
  for (const code of operation.errors ?? []) {
    const status = PROBLEM_STATUS[code];
    if (status !== undefined) statuses.add(status);
  }
  statuses.add(500);
  for (const status of [...statuses].sort((a, b) => a - b)) {
    responses[String(status)] = {
      description: 'Problem details.',
      content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
    };
  }
  return responses;
}

/**
 * How an operation's access appears in the published document.
 *
 * Exhaustive by construction: the `never` assignment turns an unhandled access
 * kind into a compile error. A default branch here would publish a new kind as
 * whatever the fallback happened to say, and the OpenAPI document is what a
 * partner or auditor reads to understand who can call what.
 */
function accessExtension(access: Access): JsonObject {
  switch (access.kind) {
    case 'public':
      return { kind: 'public' };
    case 'self':
      return { kind: 'self', stepUp: access.stepUp ?? false };
    case 'permission':
      return {
        kind: 'permission',
        permission: access.permission,
        stepUp: access.stepUp ?? false,
        movesMoney: access.movesMoney ?? false,
      };
    default: {
      const exhaustive: never = access;
      throw new Error(`Unhandled access kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function buildOpenApiDocument(
  operations: readonly OperationDefinition[],
  info: OpenApiInfo,
): JsonObject {
  const paths: Record<string, JsonObject> = {};

  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) {
      throw new Error(`Duplicate operationId: ${operation.operationId}`);
    }
    seen.add(operation.operationId);

    const parameters = [...pathParameters(operation), ...queryParameters(operation)];

    const entry: JsonObject = {
      operationId: operation.operationId,
      summary: operation.summary,
      tags: [...operation.tags],
      ...(operation.description ? { description: operation.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        [String(operation.successStatus)]: {
          description: 'Success.',
          content: { 'application/json': { schema: toSchema(operation.response) } },
        },
        ...errorResponses(operation),
      },
      // Surfaced in the document so a reviewer can read the authorization model
      // without opening a controller.
      //
      // Switched exhaustively rather than defaulted: a future access kind that
      // is not handled here becomes a compile error, instead of being silently
      // published as whatever the fallback branch said.
      'x-rayi-access': accessExtension(operation.access),
      ...(operation.access.kind === 'public' ? { security: [] } : {}),
    };

    if (operation.body) {
      entry['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: toSchema(operation.body) } },
      };
    }

    paths[operation.path] ??= {};
    (paths[operation.path] as JsonObject)[operation.method] = entry;
  }

  return {
    openapi: '3.1.0',
    info: { ...info },
    paths,
    components: {
      schemas: { Problem: toSchema(ProblemSchema) },
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-rayi.session',
          description:
            'Host-only session cookie. The API is served same-origin with the app, so there is no ' +
            'CORS, no preflight and no SameSite=None.',
        },
      },
    },
    security: [{ sessionCookie: [] }],
  };
}
