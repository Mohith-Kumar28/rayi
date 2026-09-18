import { isWorkerProcess } from './is-worker-process';

/**
 * The flag that decides which process may hold a money-moving credential.
 *
 * This helper exists because reading `IS_WORKER` the obvious way was WRONG, in a
 * direction that granted access rather than denying it. `validateConfig` runs
 * `plainToClass` with `enableImplicitConversion: true`, and class-transformer
 * coerces a boolean-typed property with `Boolean(value)` — so every non-empty
 * string, including `'false'`, became `true`.
 *
 * The Stripe secret-key constraint read the transformed value, so it answered
 * "yes, this is the worker" for `IS_WORKER=false`, which is exactly what
 * `.env.example` ships for the api process. The documented configuration
 * defeated the control that the architecture calls load-bearing.
 *
 * So: only the literal string `true` counts, and everything else fails CLOSED.
 */

describe('only the literal string true means worker', () => {
  it.each([['true'], ['TRUE'], ['True'], ['  true  ']])('accepts %p', (value) => {
    expect(isWorkerProcess({ IS_WORKER: value } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('everything else fails CLOSED', () => {
  it.each([
    ['the string false, which Boolean() turns into true', 'false'],
    ['zero', '0'],
    ['an empty string', ''],
    ['yes, which looks affirmative but is not the contract', 'yes'],
    ['1, likewise', '1'],
    ['a typo', 'ture'],
    ['whitespace only', '   '],
  ])('refuses %s', (_label, value) => {
    expect(isWorkerProcess({ IS_WORKER: value } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('refuses when the variable is absent entirely', () => {
    expect(isWorkerProcess({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('fails closed, meaning the DENYING side', () => {
    // Stated as its own assertion because the direction is the whole point. An
    // unparseable value must mean "not the worker", which refuses the
    // credential, rather than "worker", which grants it.
    const ambiguous = isWorkerProcess({ IS_WORKER: 'maybe' } as NodeJS.ProcessEnv);
    expect(ambiguous).toBe(false);
  });
});
