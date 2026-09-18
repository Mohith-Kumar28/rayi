import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { Money, CurrencyMismatchError, InvalidMoneyError, sumMoney } from './money.js';
import { UnknownCurrencyError } from './currency.js';

describe('Money.fromMinorString — the parsing failure modes that caused real bugs', () => {
  it('rejects the empty string instead of rendering a confident zero', () => {
    // BigInt('') is 0n. That is how an absent amount becomes a displayed $0.00.
    expect(BigInt('')).toBe(0n);
    expect(() => Money.fromMinorString('', 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects a decimal string instead of throwing a raw SyntaxError mid-render', () => {
    expect(() => BigInt('15000.00')).toThrow(SyntaxError);
    expect(() => Money.fromMinorString('15000.00', 'USD')).toThrow(/Malformed minor units/);
  });

  it('rejects surrounding whitespace, which BigInt silently accepts', () => {
    expect(BigInt(' 15 ')).toBe(15n);
    expect(() => Money.fromMinorString(' 15 ', 'USD')).toThrow(InvalidMoneyError);
  });

  it.each(['1e5', '+15', '0x10', '15_000', 'NaN', '--5', '007'])('rejects %s', (input) => {
    expect(() => Money.fromMinorString(input, 'USD')).toThrow(InvalidMoneyError);
  });

  it.each(['0', '15000', '-15000', '9007199254740993'])('accepts %s', (input) => {
    expect(Money.fromMinorString(input, 'USD').amountMinor).toBe(BigInt(input));
  });

  it('survives past the float-safe integer boundary', () => {
    const beyondFloat = '9007199254740993'; // 2^53 + 1, not representable as a JS number
    expect(Number(beyondFloat).toString()).not.toBe(beyondFloat);
    expect(Money.fromMinorString(beyondFloat, 'USD').toJSON().amountMinor).toBe(beyondFloat);
  });

  it('rejects an unknown currency rather than assuming two decimal places', () => {
    expect(() => Money.fromMinorString('100', 'XYZ')).toThrow(UnknownCurrencyError);
  });
});

describe('currency safety', () => {
  it('refuses to add different currencies', () => {
    const usd = Money.of(100n, 'USD');
    const eur = Money.of(100n, 'EUR');
    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.compare(eur)).toThrow(CurrencyMismatchError);
  });

  it('knows currencies that are not two-decimal', () => {
    expect(Money.of(100n, 'JPY').exponent).toBe(0);
    expect(Money.of(100n, 'BHD').exponent).toBe(3);
    expect(Money.of(100n, 'USD').exponent).toBe(2);
  });

  it('rejects a wire exponent that disagrees with the currency', () => {
    expect(() => Money.fromJSON({ amountMinor: '100', currency: 'JPY', exponent: 2 })).toThrow(
      /does not match JPY/,
    );
  });

  it('round-trips through the wire shape', () => {
    const original = Money.of(-15000n, 'USD');
    expect(Money.fromJSON(JSON.parse(JSON.stringify(original)))).toStrictEqual(original);
  });
});

describe('serialisation never emits a JSON number', () => {
  it('stringifies minor units as a string', () => {
    const encoded = JSON.stringify({ total: Money.of(15000n, 'USD') });
    expect(encoded).toContain('"amountMinor":"15000"');
    expect(encoded).not.toContain('"amountMinor":15000');
  });
});

describe('allocate — the remainder rule that keeps a milestone schedule exact', () => {
  it('splits $100.00 three ways as 3334/3333/3333', () => {
    const parts = Money.of(10000n, 'USD').allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([3334n, 3333n, 3333n]);
  });

  it('gives the odd minor unit to the earliest weight on a tie', () => {
    const parts = Money.of(10n, 'USD').allocate([1n, 1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([3n, 3n, 2n, 2n]);
  });

  it('honours unequal weights', () => {
    const parts = Money.of(10000n, 'USD').allocate([25n, 50n, 25n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([2500n, 5000n, 2500n]);
  });

  it('handles a total smaller than the number of parts', () => {
    const parts = Money.of(2n, 'USD').allocate([1n, 1n, 1n, 1n, 1n]);
    expect(parts.map((p) => p.amountMinor)).toEqual([1n, 1n, 0n, 0n, 0n]);
  });

  it.each([
    ['no weights', [] as bigint[]],
    ['weights summing to zero', [0n, 0n]],
    ['a negative weight', [-1n, 2n]],
  ])('rejects %s', (_label, weights) => {
    expect(() => Money.of(100n, 'USD').allocate(weights)).toThrow(InvalidMoneyError);
  });

  it('refuses to split a negative amount, which has no unambiguous remainder rule', () => {
    expect(() => Money.of(-100n, 'USD').allocate([1n, 1n])).toThrow(/non-negative amount/);
  });

  it('parts always sum to exactly the whole, for any total and weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 6n }), { minLength: 1, maxLength: 24 }),
        (total, weights) => {
          fc.pre(weights.reduce((a, b) => a + b, 0n) > 0n);
          const money = Money.of(total, 'USD');
          const parts = money.allocate(weights);
          expect(parts).toHaveLength(weights.length);
          expect(sumMoney(parts, 'USD').amountMinor).toBe(total);
          expect(parts.every((p) => !p.isNegative)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never differs between two parts by more than one minor unit under equal weights', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 20 }),
        (total, count) => {
          const weights = Array.from({ length: count }, () => 1n);
          const amounts = Money.of(total, 'USD')
            .allocate(weights)
            .map((p) => p.amountMinor);
          const max = amounts.reduce((a, b) => (a > b ? a : b));
          const min = amounts.reduce((a, b) => (a < b ? a : b));
          expect(max - min <= 1n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.of(15000n, 'USD');
    const b = Money.of(2500n, 'USD');
    expect(a.add(b).amountMinor).toBe(17500n);
    expect(a.subtract(b).amountMinor).toBe(12500n);
  });

  it('refuses a number where a bigint is required', () => {
    // @ts-expect-error — the runtime guard must hold even when types are bypassed.
    expect(() => Money.of(100, 'USD')).toThrow(InvalidMoneyError);
    // @ts-expect-error — same for multiply.
    expect(() => Money.of(100n, 'USD').multiply(2)).toThrow(InvalidMoneyError);
  });

  it('exposes no division — splitting goes through allocate', () => {
    const money = Money.of(100n, 'USD') as unknown as Record<string, unknown>;
    expect(money['divide']).toBeUndefined();
    expect(money['div']).toBeUndefined();
  });

  it('is immutable', () => {
    const money = Money.of(100n, 'USD');
    expect(Object.isFrozen(money)).toBe(true);
  });

  it('add is associative and commutative across arbitrary amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        (x, y, z) => {
          const a = Money.of(x, 'USD');
          const b = Money.of(y, 'USD');
          const c = Money.of(z, 'USD');
          expect(a.add(b).equals(b.add(a))).toBe(true);
          expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
          expect(a.add(b).subtract(b).equals(a)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
