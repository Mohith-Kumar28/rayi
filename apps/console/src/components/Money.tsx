/**
 * The money display primitive.
 *
 * Takes the wire shape — `{ amountMinor: "41250000", currency: "USD", exponent: 2 }` —
 * and formats it without ever producing a JavaScript number from the amount.
 * `Number("41250000")` would be fine here but is not fine at $90tn, and more
 * importantly a codebase where it is *sometimes* fine is a codebase where
 * someone eventually does it where it is not. So: string and BigInt only.
 *
 * `precision`:
 *   "auto"  — hide the fraction when it is all zeros, so a balance reads
 *             $412,500 rather than $412,500.00. Used in dense tables.
 *   "exact" — always show it. Used anywhere a number is being confirmed or
 *             entered, because $150.50 must never read as $151.
 *
 * The exponent comes from the server. There is no `?? 2` fallback anywhere:
 * defaulting an unknown currency to two decimal places misformats a 3-decimal
 * currency by 10x.
 */

export interface MoneyValue {
  amountMinor: string;
  currency: string;
  exponent: number;
}

export type MoneySize = 'hero' | 'lg' | 'base' | 'sm';

const SIZE_CLASS: Record<MoneySize, string> = {
  hero: 'text-5xl font-semibold tracking-tight tabular-nums',
  lg: 'text-2xl font-semibold tracking-tight tabular-nums',
  base: 'text-base font-medium tabular-nums',
  sm: 'text-sm tabular-nums',
};

interface Parts {
  negative: boolean;
  major: string;
  minor: string;
}

function splitMinorUnits(amountMinor: string, exponent: number): Parts {
  const negative = amountMinor.startsWith('-');
  const digits = negative ? amountMinor.slice(1) : amountMinor;
  const padded = digits.padStart(exponent + 1, '0');
  const cut = padded.length - exponent;
  return {
    negative,
    major: padded.slice(0, cut),
    minor: exponent > 0 ? padded.slice(cut) : '',
  };
}

export function formatMoney(value: MoneyValue, precision: 'auto' | 'exact' = 'auto'): string {
  const { negative, major, minor } = splitMinorUnits(value.amountMinor, value.exponent);

  // Group the integer part only. BigInt keeps this exact at any magnitude.
  const grouped = new Intl.NumberFormat('en-US').format(BigInt(major));

  const showFraction = value.exponent > 0 && (precision === 'exact' || /[^0]/.test(minor));
  const body = showFraction ? `${grouped}.${minor}` : grouped;

  const symbol = currencySymbol(value.currency);
  return `${negative ? '−' : ''}${symbol}${body}`;
}

function currencySymbol(currency: string): string {
  switch (currency) {
    case 'USD':
    case 'CAD':
    case 'AUD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'JPY':
      return '¥';
    case 'INR':
      return '₹';
    default:
      return `${currency} `;
  }
}

export function Money({
  value,
  size = 'base',
  precision = 'auto',
  className = '',
}: {
  value: MoneyValue;
  size?: MoneySize;
  precision?: 'auto' | 'exact';
  className?: string;
}) {
  const formatted = formatMoney(value, precision);
  return (
    <span
      className={`${SIZE_CLASS[size]} ${className}`}
      // The exact figure is always available to assistive tech and to a copy-paste,
      // even when the display is abbreviated.
      title={formatMoney(value, 'exact')}
    >
      {formatted}
    </span>
  );
}
