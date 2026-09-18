import { describe, expect, it } from 'vitest';

import { ALL_OPERATIONS } from './index.js';
import { buildOpenApiDocument } from './openapi.js';
import { MINOR_UNITS_PATTERN } from './money.js';

/**
 * Invariants over the operation manifest.
 *
 * These are the contract-level equivalent of the route-coverage test: they make
 * it impossible to add an endpoint that forgets to declare who may call it, or
 * that puts money on the wire as a number.
 */

const document = buildOpenApiDocument(ALL_OPERATIONS, { title: 'test', version: '0' });

describe('every operation declares its access', () => {
  it.each(ALL_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s declares access',
    (_id, operation) => {
      expect(operation.access).toBeDefined();
      if (operation.access.kind === 'permission') {
        expect(operation.access.permission).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
      } else {
        // Anything that is not permission-gated must say so explicitly. There is
        // no "no access declared" state, which is what makes forgetting one a
        // type error rather than an accidentally open endpoint.
        expect(['public', 'self']).toContain(operation.access.kind);
      }
    },
  );

  it('has no duplicate operationIds', () => {
    const ids = ALL_OPERATIONS.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never marks a GET as moving money', () => {
    for (const operation of ALL_OPERATIONS) {
      if (operation.method === 'get' && operation.access.kind === 'permission') {
        expect(operation.access.movesMoney ?? false).toBe(false);
      }
    }
  });
});

describe('path parameters are declared, not implied', () => {
  it.each(ALL_OPERATIONS.map((op) => [op.operationId, op] as const))(
    '%s declares a schema for every {placeholder} in its path',
    (_id, operation) => {
      const placeholders = [...operation.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      if (placeholders.length === 0) return;

      expect(operation.pathParams, `${operation.operationId} has path params but no schema`).toBeDefined();
      const declared = Object.keys(
        (operation.pathParams as unknown as { shape: Record<string, unknown> }).shape,
      );
      for (const placeholder of placeholders) {
        expect(declared).toContain(placeholder);
      }
    },
  );

  it('never gives a self-scoped route an orgId, because it has no tenant', () => {
    // A `self` route authorised against an organization would be authorised
    // against something that has nothing to do with the resource.
    for (const operation of ALL_OPERATIONS) {
      if (operation.access.kind !== 'self') continue;
      expect(operation.path).not.toContain('{orgId}');
    }
  });

  it('scopes every tenant route by an explicit orgId in the path', () => {
    // Scope must come from the URL, never from session.activeOrganizationId: that
    // field is shared mutable state across tabs, so an agency operator with two
    // clients open would otherwise act against the wrong organization.
    const tenantOperations = ALL_OPERATIONS.filter((op) => op.access.kind === 'permission');
    for (const operation of tenantOperations) {
      expect(operation.path, `${operation.operationId} is not org-scoped`).toContain('{orgId}');
    }
  });
});

describe('money never crosses the wire as a JSON number', () => {
  /** Walks the generated document looking for anything money-shaped typed as a number. */
  function findMoneyNumbers(node: unknown, path: string[] = []): string[] {
    const offenders: string[] = [];
    if (Array.isArray(node)) {
      node.forEach((child, index) => offenders.push(...findMoneyNumbers(child, [...path, String(index)])));
      return offenders;
    }
    if (typeof node !== 'object' || node === null) return offenders;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        /amount|minor|balance|total|price|fee/i.test(key) &&
        typeof value === 'object' &&
        value !== null &&
        (value as Record<string, unknown>)['type'] === 'number'
      ) {
        offenders.push([...path, key].join('.'));
      }
      offenders.push(...findMoneyNumbers(value, [...path, key]));
    }
    return offenders;
  }

  it('has no money-shaped field typed as a number anywhere in the spec', () => {
    expect(findMoneyNumbers(document)).toEqual([]);
  });

  it('types amountMinor as a string with an integer pattern', () => {
    const schema = (document as never as Record<string, never>)['paths'][
      '/v1/orgs/{orgId}/funds'
    ]['get']['responses']['200']['content']['application/json']['schema'] as Record<string, never>;

    const amountMinor = schema['properties']['available']['properties']['amountMinor'] as Record<
      string,
      string
    >;

    expect(amountMinor['type']).toBe('string');
    expect(amountMinor['pattern']).toBe(MINOR_UNITS_PATTERN);
  });

  it('rejects a decimal string against the declared pattern', () => {
    const pattern = new RegExp(MINOR_UNITS_PATTERN);
    expect(pattern.test('15000')).toBe(true);
    expect(pattern.test('-15000')).toBe(true);
    expect(pattern.test('0')).toBe(true);
    expect(pattern.test('15000.00')).toBe(false);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('1e5')).toBe(false);
    expect(pattern.test('007')).toBe(false);
  });
});

describe('the generated document is well formed', () => {
  it('is OpenAPI 3.1 with a Problem schema and a security scheme', () => {
    expect(document['openapi']).toBe('3.1.0');
    const components = document['components'] as Record<string, Record<string, unknown>>;
    expect(components['schemas']?.['Problem']).toBeDefined();
    expect(components['securitySchemes']?.['sessionCookie']).toBeDefined();
  });

  it('documents a 500 response on every operation', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const responses = operation['responses'] as Record<string, unknown>;
        expect(responses['500'], `${method.toUpperCase()} ${path} has no 500`).toBeDefined();
      }
    }
  });

  it('surfaces the access model in the document so it is reviewable without opening a controller', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const allocate = paths['/v1/orgs/{orgId}/campaigns/{campaignId}/allocations']!['post']!;
    expect(allocate['x-rayi-access']).toEqual({
      kind: 'permission',
      permission: 'campaign:allocate',
      stepUp: false,
      movesMoney: true,
    });
  });
});
