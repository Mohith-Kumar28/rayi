import { assertCurrency, exponentOf, type Currency } from '@rayi/domain';

/**
 * The one place a `bigint` becomes money on the wire.
 *
 * There were three copies of this before — one per controller — each with a
 * slightly different signature, and one of them hard-coded the platform
 * currency. Three copies of the money serialisation boundary is three places a
 * `.toString()` can be forgotten and a JSON number can appear instead.
 *
 * `amountMinor` is a STRING because a JSON number loses precision past 2^53,
 * and `exponent` is derived from the currency HERE rather than defaulted: a
 * `?? 2` misformats a three-decimal currency by 10x, and there is none anywhere
 * in this codebase.
 */
export interface MoneyDto {
  readonly amountMinor: string;
  readonly currency: Currency;
  readonly exponent: number;
}

/** Narrows the currency and derives its exponent. Throws on an unknown code. */
export function money(amountMinor: bigint, currency: string): MoneyDto {
  const narrowed = assertCurrency(currency);
  return {
    amountMinor: amountMinor.toString(),
    currency: narrowed,
    exponent: exponentOf(narrowed),
  };
}

/**
 * For a caller that has already narrowed the currency once for a whole
 * response and does not want to re-derive the exponent per field.
 */
export function moneyIn(
  amountMinor: bigint,
  currency: Currency,
  exponent: number,
): MoneyDto {
  return { amountMinor: amountMinor.toString(), currency, exponent };
}
