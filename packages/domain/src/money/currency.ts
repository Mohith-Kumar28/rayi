/**
 * ISO-4217 currency codes and their minor-unit exponents.
 *
 * The exponent is how many decimal places the currency has, i.e. how many minor
 * units make one major unit. USD has exponent 2 (100 cents = $1). JPY has
 * exponent 0 (there are no sen). BHD has exponent 3 (1000 fils = 1 dinar).
 *
 * This table exists because the `?? 2` fallback is a real bug: defaulting an
 * unknown currency to 2 decimal places misformats a 3-decimal currency by 10x
 * and a 0-decimal currency by 100x. An unknown currency must be an error, never
 * a guess.
 */

export const CURRENCY_EXPONENTS = {
  USD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
} as const satisfies Record<string, number>;

export type Currency = keyof typeof CURRENCY_EXPONENTS;

export class UnknownCurrencyError extends Error {
  readonly code = 'UNKNOWN_CURRENCY';
  constructor(readonly value: string) {
    super(
      `Unknown currency ${JSON.stringify(value)}. ` +
        `Add it to CURRENCY_EXPONENTS with its correct ISO-4217 exponent — never assume 2.`,
    );
    this.name = 'UnknownCurrencyError';
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

/** Narrows an untrusted string to a Currency, or throws. */
export function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new UnknownCurrencyError(String(value));
  }
  return value;
}

/** Minor-unit exponent for a currency. Total — every Currency has one by construction. */
export function exponentOf(currency: Currency): number {
  return CURRENCY_EXPONENTS[currency];
}
