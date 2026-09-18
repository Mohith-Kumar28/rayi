import { isRetryable, isTerminal, sqlStateOf, withRetry } from './retry';

/** Mimics how node-postgres and Prisma surface a driver error. */
function pgError(code: string, message = 'db error') {
  return Object.assign(new Error(message), { code });
}

function wrapped(code: string) {
  // Prisma wraps the driver error, so the SQLSTATE is on `cause`.
  return Object.assign(new Error('Invalid `prisma.$queryRaw()` invocation'), {
    cause: pgError(code),
  });
}

describe('sqlStateOf', () => {
  it('reads a SQLSTATE off the error itself', () => {
    expect(sqlStateOf(pgError('40001'))).toBe('40001');
  });

  it('walks the cause chain, since ORMs wrap the driver error', () => {
    expect(sqlStateOf(wrapped('23514'))).toBe('23514');
  });

  it('survives a deep chain without looping forever', () => {
    let error: unknown = pgError('40P01');
    for (let i = 0; i < 5; i += 1)
      error = Object.assign(new Error('wrap'), { cause: error });
    expect(sqlStateOf(error)).toBe('40P01');
  });

  it('returns undefined when there is no SQLSTATE', () => {
    expect(sqlStateOf(new Error('plain'))).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
  });

  it('ignores non-SQLSTATE codes such as Node errno strings', () => {
    expect(sqlStateOf(pgError('ECONNREFUSED'))).toBeUndefined();
  });
});

describe('what may be retried', () => {
  it.each([
    ['40001', 'serialization failure'],
    ['40P01', 'deadlock'],
    ['55P03', 'lock not available'],
  ])('retries %s (%s)', (code) => {
    expect(isRetryable(pgError(code))).toBe(true);
  });

  /**
   * The distinction that matters most. A check violation is the database
   * CORRECTLY refusing an overdraft or an unbalanced entry. Retrying it would
   * turn a clear, immediate error into five attempts and a dead letter.
   */
  it.each([
    ['23514', 'overdraft / unbalanced entry'],
    ['23505', 'idempotency key already used'],
    ['23503', 'unknown account'],
    ['0A000', 'append-only trigger'],
  ])('never retries %s (%s)', (code) => {
    expect(isRetryable(pgError(code))).toBe(false);
    expect(isTerminal(pgError(code))).toBe(true);
  });

  it('does not retry an error with no SQLSTATE — an unknown failure is not assumed transient', () => {
    expect(isRetryable(new Error('who knows'))).toBe(false);
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};

  it('returns the first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a serialization failure and succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(pgError('40001'))
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on an overdraft rather than retrying', async () => {
    const fn = jest
      .fn()
      .mockRejectedValue(pgError('23514', 'non-negative violated'));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow(
      'non-negative violated',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the original error', async () => {
    const fn = jest
      .fn()
      .mockRejectedValue(pgError('40001', 'still conflicting'));
    await expect(
      withRetry(fn, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow('still conflicting');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports each retry so contention is observable rather than invisible', async () => {
    const onRetry = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockResolvedValue('ok');

    await withRetry(fn, { sleep: noSleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
  });

  it('backs off with jitter, so a burst on one hot account does not retry in lockstep', async () => {
    const delays: number[] = [];
    const fn = jest.fn().mockRejectedValue(pgError('40001'));

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => undefined);

    expect(delays).toHaveLength(4);
    // Full jitter: each delay is somewhere in [0, 100 * 2^(attempt-1)).
    delays.forEach((delay, index) => {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(100 * 2 ** index);
    });
  });
});
