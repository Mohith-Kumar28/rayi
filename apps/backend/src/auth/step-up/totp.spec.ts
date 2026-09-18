import { decodeBase32, DEFAULT_PERIOD, generateAt, verifyTotp } from './totp';

/**
 * Checked against RFC 6238's OWN test vectors.
 *
 * This is the justification for implementing TOTP here rather than depending on
 * a package: correctness is verified against the specification's published
 * table, not against my reading of the specification. An implementation that
 * reproduces Appendix B for all three hash algorithms is correct in the only
 * sense that matters.
 */

// RFC 6238 Appendix B. The ASCII seed is "12345678901234567890", extended to
// the key length each algorithm requires.
const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const SEED_SHA512 = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

/** The vector table: time in seconds, and the expected 8-digit code. */
const VECTORS: Array<{
  time: number;
  sha1: string;
  sha256: string;
  sha512: string;
}> = [
  { time: 59, sha1: '94287082', sha256: '46119246', sha512: '90693936' },
  {
    time: 1111111109,
    sha1: '07081804',
    sha256: '68084774',
    sha512: '25091201',
  },
  {
    time: 1111111111,
    sha1: '14050471',
    sha256: '67062674',
    sha512: '99943326',
  },
  {
    time: 1234567890,
    sha1: '89005924',
    sha256: '91819424',
    sha512: '93441116',
  },
  {
    time: 2000000000,
    sha1: '69279037',
    sha256: '90698825',
    sha512: '38618901',
  },
  {
    time: 20000000000,
    sha1: '65353130',
    sha256: '77737706',
    sha512: '47863826',
  },
];

describe('RFC 6238 Appendix B test vectors', () => {
  it.each(VECTORS)('SHA-1 at T=$time', ({ time, sha1 }) => {
    const counter = Math.floor(time / DEFAULT_PERIOD);
    expect(
      generateAt(SEED_SHA1, counter, { digits: 8, algorithm: 'sha1' }),
    ).toBe(sha1);
  });

  it.each(VECTORS)('SHA-256 at T=$time', ({ time, sha256 }) => {
    const counter = Math.floor(time / DEFAULT_PERIOD);
    expect(
      generateAt(SEED_SHA256, counter, { digits: 8, algorithm: 'sha256' }),
    ).toBe(sha256);
  });

  it.each(VECTORS)('SHA-512 at T=$time', ({ time, sha512 }) => {
    const counter = Math.floor(time / DEFAULT_PERIOD);
    expect(
      generateAt(SEED_SHA512, counter, { digits: 8, algorithm: 'sha512' }),
    ).toBe(sha512);
  });

  it('handles T=20000000000, the largest vector, where the TIME exceeds 32 bits', () => {
    // The RFC includes this case because the TIME (2e10 seconds, year 2603)
    // does not fit in a signed 32-bit integer, so an implementation that stores
    // seconds in one gets it wrong. The derived counter is only ~6.7e8 and fits
    // comfortably — this asserts the vector, not a counter overflow.
    const counter = Math.floor(20000000000 / DEFAULT_PERIOD);
    expect(20000000000).toBeGreaterThan(0x7fffffff);
    expect(generateAt(SEED_SHA1, counter, { digits: 8 })).toBe('65353130');
  });
});

describe('verification', () => {
  const secret = 'JBSWY3DPEHPK3PXP'; // base32, a common example value
  const at = (seconds: number) => new Date(seconds * 1000);

  function codeAt(seconds: number): string {
    const key = decodeBase32(secret)!;
    return generateAt(key, Math.floor(seconds / DEFAULT_PERIOD));
  }

  it('accepts the current code', () => {
    const now = 1_700_000_000;
    expect(
      verifyTotp({ secret, code: codeAt(now), options: { now: at(now) } }),
    ).toBe(true);
  });

  it('accepts a code from the previous window, for a slow phone clock', () => {
    // A rigid check locks people out for a reason they cannot see or fix.
    const now = 1_700_000_000;
    expect(
      verifyTotp({
        secret,
        code: codeAt(now - DEFAULT_PERIOD),
        options: { now: at(now) },
      }),
    ).toBe(true);
  });

  it('accepts a code from the next window, for a fast one', () => {
    const now = 1_700_000_000;
    expect(
      verifyTotp({
        secret,
        code: codeAt(now + DEFAULT_PERIOD),
        options: { now: at(now) },
      }),
    ).toBe(true);
  });

  it('REJECTS a code two windows old', () => {
    // More tolerance than this turns a 30-second code into a multi-minute one,
    // which is the entire security property.
    const now = 1_700_000_000;
    expect(
      verifyTotp({
        secret,
        code: codeAt(now - 2 * DEFAULT_PERIOD),
        options: { now: at(now) },
      }),
    ).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    const now = 1_700_000_000;
    const other = decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')!;
    const foreign = generateAt(other, Math.floor(now / DEFAULT_PERIOD));
    expect(
      verifyTotp({ secret, code: foreign, options: { now: at(now) } }),
    ).toBe(false);
  });

  it('tolerates spaces, which is how people type a code they can see', () => {
    const now = 1_700_000_000;
    const code = codeAt(now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(
      verifyTotp({ secret, code: spaced, options: { now: at(now) } }),
    ).toBe(true);
  });

  it.each([
    ['too short', '12345'],
    ['too long', '1234567'],
    ['letters', 'abcdef'],
    ['empty', ''],
    ['a sign', '+12345'],
    ['a decimal', '123.45'],
  ])('rejects a malformed code — %s', (_label, code) => {
    expect(
      verifyTotp({ secret, code, options: { now: at(1_700_000_000) } }),
    ).toBe(false);
  });

  it('rejects when the secret is unusable rather than throwing', () => {
    expect(verifyTotp({ secret: '', code: '123456' })).toBe(false);
    expect(verifyTotp({ secret: '!!!!', code: '123456' })).toBe(false);
  });

  it('honours an explicit window of zero', () => {
    const now = 1_700_000_000;
    expect(
      verifyTotp({
        secret,
        code: codeAt(now - DEFAULT_PERIOD),
        options: { now: at(now), window: 0 },
      }),
    ).toBe(false);
  });
});

describe('base32 decoding', () => {
  it('decodes a known value', () => {
    // "Hello!\xDE\xAD\xBE\xEF" is the canonical example for JBSWY3DPEHPK3PXP.
    expect(decodeBase32('JBSWY3DPEHPK3PXP')?.toString('hex')).toBe(
      '48656c6c6f21deadbeef',
    );
  });

  it('tolerates lower case, padding and whitespace', () => {
    const expected = decodeBase32('JBSWY3DPEHPK3PXP')!.toString('hex');
    expect(decodeBase32('jbswy3dpehpk3pxp')?.toString('hex')).toBe(expected);
    expect(decodeBase32('JBSW Y3DP EHPK 3PXP')?.toString('hex')).toBe(expected);
    expect(decodeBase32('JBSWY3DPEHPK3PXP====')?.toString('hex')).toBe(
      expected,
    );
  });

  it('REFUSES an invalid character rather than skipping it', () => {
    // Skipping yields a DIFFERENT key, so every code fails afterwards for a
    // reason nothing reports — the worst kind of silent wrongness.
    expect(decodeBase32('JBSWY3DP!HPK3PXP')).toBeNull();
    expect(decodeBase32('JBSWY3DP1HPK3PXP')).toBeNull(); // 1 and 0 are not in the alphabet
    expect(decodeBase32('JBSWY3DP0HPK3PXP')).toBeNull();
  });

  it('returns null for an empty secret', () => {
    expect(decodeBase32('')).toBeNull();
    expect(decodeBase32('   ')).toBeNull();
  });
});
