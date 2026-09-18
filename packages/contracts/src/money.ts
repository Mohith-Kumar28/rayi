import { z } from 'zod';

/**
 * The wire representation of money.
 *
 * `amountMinor` is a STRING of integer minor units, declared to OpenAPI as
 * `type: string` with an integer pattern, so generated clients emit a branded
 * string rather than a number. A JSON number would lose precision past 2^53,
 * which is reachable: 2^53 minor units is about $90 trillion, but a mistakenly
 * major-unit-scaled value, an aggregate across an org, or a malicious input
 * gets there far sooner.
 *
 * `exponent` is SERVER-SUPPLIED. Clients must never infer it, and must never
 * fall back to 2 — that silently misformats a 3-decimal currency by 10x.
 */

export const MINOR_UNITS_PATTERN = '^-?(0|[1-9][0-9]*)$';

export const CurrencySchema = z
  .enum(['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'INR', 'JPY', 'KRW', 'BHD', 'KWD'])
  .describe('ISO-4217 currency code.');

export const MoneySchema = z
  .object({
    amountMinor: z
      .string()
      .regex(new RegExp(MINOR_UNITS_PATTERN))
      .describe('Integer minor units as a string. Never a JSON number — precision is not optional here.'),
    currency: CurrencySchema,
    exponent: z
      .int()
      .min(0)
      .max(4)
      .describe('Minor-unit exponent for this currency, supplied by the server. Never assume 2.'),
  })
  .describe('A monetary amount in integer minor units.');

export type MoneyWire = z.infer<typeof MoneySchema>;

/**
 * Money as REQUEST input.
 *
 * Deliberately omits `exponent`: the client does not get to assert what a
 * currency's exponent is, and a request that disagreed with the server would be
 * ambiguous rather than merely wrong.
 */
export const MoneyInputSchema = z
  .object({
    amountMinor: z.string().regex(new RegExp(MINOR_UNITS_PATTERN)),
    currency: CurrencySchema,
  })
  .describe('A monetary amount supplied by a client. The server derives the exponent.');

export type MoneyInput = z.infer<typeof MoneyInputSchema>;
