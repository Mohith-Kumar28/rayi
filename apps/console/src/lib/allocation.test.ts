import { describe, expect, it } from 'vitest';

import { allocationIdempotencyKey, toMinorUnits } from './allocation';

describe('toMinorUnits', () => {
  it.each([
    ['150.50', '15050'],
    ['150.5', '15050'],
    ['150', '15000'],
    ['0.05', '5'],
    ['0.50', '50'],
    ['.5', '50'],
    ['0', '0'],
    ['0.00', '0'],
    ['1000000', '100000000'],
    ['  25.00  ', '2500'],
  ])('converts %s to %s', (input, expected) => {
    expect(toMinorUnits(input)).toBe(expected);
  });

  it.each([
    // Each of these loses a cent under `parseFloat(x) * 100` followed by a
    // truncation — the shape of the conversion this function replaces. Verified
    // against the actual IEEE-754 results, not assumed.
    ['8.20', '820', 819.9999999999999],
    ['16.08', '1608', 1607.9999999999998],
    ['0.29', '29', 28.999999999999996],
    ['35.41', '3541', 3540.9999999999995],
  ])('converts %s exactly, where float arithmetic would lose a cent', (input, expected, lossy) => {
    expect(toMinorUnits(input)).toBe(expected);

    // The failure being avoided, stated concretely: multiplying by 100 does not
    // land on an integer, and truncating is a cent gone for good.
    expect(Number.parseFloat(input) * 100).toBe(lossy);
    expect(Math.trunc(lossy)).toBe(Number(expected) - 1);
  });

  it.each([
    ['a negative amount', '-5'],
    ['an explicit plus', '+5'],
    ['more precision than the currency has', '1.005'],
    ['two decimal points', '1.0.0'],
    ['letters', '25abc'],
    ['exponential notation', '1e5'],
    ['an empty string', ''],
    ['only whitespace', '   '],
    ['a lone dot', '.'],
    ['a thousands separator', '1,000'],
  ])('refuses %s rather than guessing', (_label, input) => {
    expect(toMinorUnits(input)).toBeNull();
  });

  it('always produces a value the wire contract accepts', () => {
    const pattern = /^(0|[1-9][0-9]*)$/;
    for (const input of ['0', '0.01', '1', '007.50', '123456.78']) {
      const minor = toMinorUnits(input);
      expect(minor).not.toBeNull();
      expect(minor as string).toMatch(pattern);
    }
  });

  it('honours a currency exponent other than 2', () => {
    // JPY has no minor unit; BHD has three. The `?? 2` fallback this avoids
    // misformats a 3-decimal currency by a factor of ten.
    expect(toMinorUnits('1500', 0)).toBe('1500');
    expect(toMinorUnits('1.234', 3)).toBe('1234');
    expect(toMinorUnits('1.5', 3)).toBe('1500');
    expect(toMinorUnits('1.2345', 3)).toBeNull();
  });
});

describe('allocationIdempotencyKey', () => {
  const campaignId = 'c0ffee00-0000-4000-8000-000000000000';

  it('is identical for the same intent, so a refresh does not double-allocate', () => {
    const first = allocationIdempotencyKey({
      campaignId,
      allocatedMinor: '0',
      amountMinor: '500000',
    });
    const afterRefresh = allocationIdempotencyKey({
      campaignId,
      allocatedMinor: '0',
      amountMinor: '500000',
    });
    expect(afterRefresh).toBe(first);
  });

  it('DIFFERS once the first allocation has landed, so a real second one goes through', () => {
    // THE regression this file exists for. Keying on the amount alone made a
    // legitimate second $5,000 allocation look like a replay of the first.
    const before = allocationIdempotencyKey({
      campaignId,
      allocatedMinor: '0',
      amountMinor: '500000',
    });
    const after = allocationIdempotencyKey({
      campaignId,
      allocatedMinor: '500000',
      amountMinor: '500000',
    });
    expect(after).not.toBe(before);
  });

  it('differs between campaigns holding the same balance', () => {
    const a = allocationIdempotencyKey({ campaignId, allocatedMinor: '0', amountMinor: '100' });
    const b = allocationIdempotencyKey({
      campaignId: 'deadbeef-0000-4000-8000-000000000000',
      allocatedMinor: '0',
      amountMinor: '100',
    });
    expect(a).not.toBe(b);
  });

  it('is long enough for the contract, which requires at least 16 characters', () => {
    const key = allocationIdempotencyKey({ campaignId, allocatedMinor: '0', amountMinor: '1' });
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});
