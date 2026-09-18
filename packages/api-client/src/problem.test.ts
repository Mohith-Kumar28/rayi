import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ProblemSchema } from '@rayi/contracts';

import { parseProblem } from './problem';

/**
 * The guard and the contract must agree.
 *
 * `parseProblem` is hand-written so that Zod and the entire operation manifest
 * stay out of the browser bundle — 672 KB shipped to every visitor so a failed
 * request could be parsed, paid hardest by a creator on mobile data.
 *
 * The risk that buys is DRIFT. So these tests feed the same inputs to the
 * contract's own schema and to the guard, and assert they reach the same verdict.
 * Drift becomes a failing test rather than a surprise in an error path nobody
 * looks at.
 *
 * This file imports `@rayi/contracts` freely — it is a test, and never bundled.
 */

const VALID = {
  type: 'https://rayi.com/problems/forbidden',
  title: 'Not permitted',
  status: 403,
  code: 'forbidden',
  requestId: 'req_123',
};

describe('the guard knows every code the contract does', () => {
  it('accepts all of them', () => {
    // A code the guard does not know is a real error rendered as "something went
    // wrong", which is the least useful message available.
    for (const code of ERROR_CODES) {
      expect(parseProblem({ ...VALID, code })?.code, code).toBe(code);
    }
  });

  it('has no codes the contract does not', () => {
    const contractCodes = new Set<string>(ERROR_CODES);
    // Probe with a code the contract does not define; the guard must refuse it.
    expect(contractCodes.has('made_up_code')).toBe(false);
    expect(parseProblem({ ...VALID, code: 'made_up_code' })).toBeNull();
  });
});

describe('the guard and the schema agree on every input', () => {
  const CASES: Array<[string, unknown]> = [
    ['a valid problem', VALID],
    ['with a detail', { ...VALID, detail: 'You need money authority.' }],
    ['with an instance', { ...VALID, instance: '/v1/orgs/x/allocations' }],
    [
      'with a step-up challenge',
      {
        ...VALID,
        code: 'step_up_required',
        challenge: {
          challengeId: 'ch_1',
          reason: 'release',
          expiresAt: '2026-06-01T12:00:00.000Z',
        },
      },
    ],
    ['missing code', { type: 'x', title: 'y', status: 400, requestId: 'r' }],
    ['unknown code', { ...VALID, code: 'nonsense' }],
    ['missing title', { ...VALID, title: undefined }],
    ['missing requestId', { ...VALID, requestId: undefined }],
    ['status as a string', { ...VALID, status: '403' }],
    ['status not an integer', { ...VALID, status: 403.5 }],
    ['null', null],
    ['an array', [VALID]],
    ['a string', 'forbidden'],
    ['a number', 403],
    ['an empty object', {}],
  ];

  it.each(CASES)('agrees on %s', (_label, input) => {
    const schemaAccepts = ProblemSchema.safeParse(input).success;
    const guardAccepts = parseProblem(input) !== null;
    expect(guardAccepts).toBe(schemaAccepts);
  });
});

describe('the parsed value', () => {
  it('carries the fields a UI needs', () => {
    const problem = parseProblem({ ...VALID, detail: 'Ask an owner.' });
    expect(problem).toMatchObject({
      code: 'forbidden',
      title: 'Not permitted',
      detail: 'Ask an owner.',
      requestId: 'req_123',
    });
  });

  it('OMITS an absent detail rather than setting it undefined', () => {
    // `'detail' in problem` is how a UI decides whether to render the second
    // line at all.
    expect('detail' in (parseProblem(VALID) as object)).toBe(false);
  });

  it('carries the step-up challenge, which a dialog must read from here', () => {
    // The amount and counterparty in a confirmation dialog come from the
    // challenge, never from client cache — otherwise a compromised dependency
    // could show one amount while a different one is paid.
    const problem = parseProblem({
      ...VALID,
      code: 'step_up_required',
      challenge: { challengeId: 'ch_1', reason: 'release', expiresAt: '2026-06-01T12:00:00.000Z' },
    });
    expect(problem?.challenge?.challengeId).toBe('ch_1');
  });

  it('drops a malformed challenge rather than half-reading it', () => {
    const problem = parseProblem({ ...VALID, challenge: { challengeId: 'ch_1' } });
    expect(problem).not.toBeNull();
    expect(problem?.challenge).toBeUndefined();
  });

  it('NEVER throws, whatever it is given', () => {
    // The caller is already handling a failure. A parser that throws inside an
    // error path turns a 409 into an unhandled exception with no message a user
    // can act on.
    for (const input of [undefined, null, 0, '', [], {}, { code: 1 }, Symbol('x')]) {
      expect(() => parseProblem(input)).not.toThrow();
    }
  });
});
