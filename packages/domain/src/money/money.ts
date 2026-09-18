/**
 * Money — the only representation of an amount anywhere in Rayi.
 *
 * Rules this type exists to make unbreakable:
 *
 *  1. Amounts are integer MINOR UNITS held as `bigint`. Never a float, never a
 *     JS `number` (the 2^53 boundary is reachable with real money), never a
 *     decimal string that someone might parse with `parseFloat`.
 *  2. Arithmetic across different currencies throws. There is no implicit
 *     conversion and no "default" currency.
 *  3. There is NO division. Splitting an amount is `allocate()`, which
 *     distributes the remainder deterministically and asserts that the parts
 *     sum back to exactly the whole. This is what makes a percentage-based
 *     milestone schedule safe: $100 split three ways is 3334/3333/3333, not
 *     three lots of 33.33 that quietly lose a cent.
 *  4. It serialises as `{ amountMinor: "15000", currency: "USD", exponent: 2 }`
 *     — a STRING of minor units with a server-supplied exponent. `toJSON` is
 *     defined so an accidental `JSON.stringify` cannot emit a lossy number.
 */

import { assertCurrency, exponentOf, type Currency } from './currency.js';

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(
    readonly left: Currency,
    readonly right: Currency,
  ) {
    super(`Cannot combine ${left} with ${right}. Money arithmetic never converts between currencies.`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/** The wire shape. Minor units as a string; never a JSON number. */
export interface MoneyJSON {
  readonly amountMinor: string;
  readonly currency: Currency;
  readonly exponent: number;
}

/** Matches an optionally-negative integer with no leading `+`, no decimal point, no exponent. */
const MINOR_UNITS_PATTERN = /^-?(0|[1-9][0-9]*)$/;

export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  static of(amountMinor: bigint, currency: Currency): Money {
    if (typeof amountMinor !== 'bigint') {
      throw new InvalidMoneyError(
        `Money.of requires a bigint, received ${typeof amountMinor}. A number cannot represent money exactly.`,
      );
    }
    return new Money(amountMinor, assertCurrency(currency));
  }

  static zero(currency: Currency): Money {
    return new Money(0n, assertCurrency(currency));
  }

  /**
   * Parses minor units from an untrusted string.
   *
   * Deliberately strict, because the permissive version has three known
   * failure modes: `BigInt("")` returns `0n` and renders a confident $0.00;
   * `BigInt("15000.00")` throws a raw SyntaxError mid-render; and `BigInt(" 15")`
   * silently succeeds, so whitespace corruption passes review.
   */
  static fromMinorString(amountMinor: string, currency: unknown): Money {
    if (typeof amountMinor !== 'string') {
      throw new InvalidMoneyError(`Expected minor units as a string, received ${typeof amountMinor}.`);
    }
    if (!MINOR_UNITS_PATTERN.test(amountMinor)) {
      throw new InvalidMoneyError(
        `Malformed minor units ${JSON.stringify(amountMinor)}. ` +
          `Expected an integer string such as "15000" — no decimal point, no exponent, no whitespace.`,
      );
    }
    return new Money(BigInt(amountMinor), assertCurrency(currency));
  }

  /** Parses the wire shape. Verifies the exponent matches, so a mismatched client is caught here. */
  static fromJSON(value: unknown): Money {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidMoneyError(`Expected a Money object, received ${value === null ? 'null' : typeof value}.`);
    }
    const { amountMinor, currency, exponent } = value as Partial<MoneyJSON>;
    const money = Money.fromMinorString(amountMinor as string, currency);
    if (exponent !== undefined && exponent !== money.exponent) {
      throw new InvalidMoneyError(
        `Exponent ${exponent} does not match ${money.currency}'s actual exponent ${money.exponent}.`,
      );
    }
    return money;
  }

  get exponent(): number {
    return exponentOf(this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  /** Scales by an integer factor. There is no scale-by-fraction; use `allocate`. */
  multiply(factor: bigint): Money {
    if (typeof factor !== 'bigint') {
      throw new InvalidMoneyError(`multiply requires a bigint factor, received ${typeof factor}.`);
    }
    return new Money(this.amountMinor * factor, this.currency);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  abs(): Money {
    return this.amountMinor < 0n ? this.negate() : this;
  }

  /**
   * Splits this amount across `weights`, distributing the remainder by the
   * largest-remainder method. Ties resolve to the EARLIEST index, so a
   * milestone schedule gives the odd cent to the earliest milestone.
   *
   * Guarantees, asserted before returning:
   *   - the parts sum to exactly this amount
   *   - there is one part per weight
   *
   * Requires a non-negative amount and non-negative weights summing above zero.
   */
  allocate(weights: readonly bigint[]): Money[] {
    if (weights.length === 0) {
      throw new InvalidMoneyError('allocate requires at least one weight.');
    }
    if (this.amountMinor < 0n) {
      throw new InvalidMoneyError(
        'allocate requires a non-negative amount. Negative splits have no unambiguous remainder rule.',
      );
    }

    let totalWeight = 0n;
    for (const weight of weights) {
      if (typeof weight !== 'bigint') {
        throw new InvalidMoneyError(`allocate requires bigint weights, received ${typeof weight}.`);
      }
      if (weight < 0n) {
        throw new InvalidMoneyError('allocate requires non-negative weights.');
      }
      totalWeight += weight;
    }
    if (totalWeight === 0n) {
      throw new InvalidMoneyError('allocate requires the weights to sum above zero.');
    }

    // Floor share plus the fractional remainder, tracked exactly in integers.
    const shares: bigint[] = [];
    const remainders: Array<{ index: number; remainder: bigint }> = [];
    let distributed = 0n;

    for (let index = 0; index < weights.length; index += 1) {
      const weight = weights[index] as bigint;
      const scaled = this.amountMinor * weight;
      const share = scaled / totalWeight;
      shares.push(share);
      remainders.push({ index, remainder: scaled % totalWeight });
      distributed += share;
    }

    // Hand out the leftover minor units, largest remainder first, ties to the earliest index.
    let leftover = this.amountMinor - distributed;
    remainders.sort((a, b) => {
      if (a.remainder === b.remainder) return a.index - b.index;
      return a.remainder > b.remainder ? -1 : 1;
    });
    for (const { index } of remainders) {
      if (leftover <= 0n) break;
      shares[index] = (shares[index] as bigint) + 1n;
      leftover -= 1n;
    }

    const parts = shares.map((share) => new Money(share, this.currency));

    // Belt and braces: this invariant is the entire reason the method exists.
    const sum = parts.reduce((acc, part) => acc + part.amountMinor, 0n);
    if (sum !== this.amountMinor) {
      throw new InvalidMoneyError(
        `allocate produced ${sum} but the total is ${this.amountMinor}. This is a bug in allocate.`,
      );
    }
    return parts;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinor < other.amountMinor) return -1;
    if (this.amountMinor > other.amountMinor) return 1;
    return 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  get isZero(): boolean {
    return this.amountMinor === 0n;
  }

  get isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  get isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  toJSON(): MoneyJSON {
    return {
      amountMinor: this.amountMinor.toString(),
      currency: this.currency,
      exponent: this.exponent,
    };
  }

  /** Debug only. Never parse this, and never show it to a user — the UI formats from `toJSON`. */
  toString(): string {
    return `${this.amountMinor.toString()} ${this.currency} (e${this.exponent})`;
  }
}

/** Sums money of a single currency. An empty list needs an explicit currency, so zero is still typed. */
export function sumMoney(amounts: readonly Money[], currency: Currency): Money {
  return amounts.reduce((acc, amount) => acc.add(amount), Money.zero(currency));
}
