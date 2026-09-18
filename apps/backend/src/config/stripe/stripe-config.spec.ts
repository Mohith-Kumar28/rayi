import stripeConfig from './stripe.config';

/**
 * Proof behind the architecture's central claim: compromising the
 * internet-reachable api process yields no ability to move money.
 *
 * That claim is only true if api genuinely cannot hold a full Stripe secret key,
 * and the only thing that makes it true is this boot failure.
 */
describe('stripe config — role-scoped credentials', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_RESTRICTED_KEY;
    delete process.env.IS_WORKER;
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('refuses a full secret key on a non-worker process', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_realkeyhere';
    expect(() => stripeConfig()).toThrow(/may only be present on the worker/);
  });

  it('explains why, so nobody "fixes" it by loosening the check', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_realkeyhere';
    expect(() => stripeConfig()).toThrow(/internet-reachable/);
    expect(() => stripeConfig()).toThrow(/STRIPE_RESTRICTED_KEY/);
  });

  it('allows a full secret key on the worker', async () => {
    process.env.IS_WORKER = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_live_realkeyhere';
    expect((await stripeConfig()).secretKey).toBe('sk_live_realkeyhere');
  });

  it('allows a restricted key anywhere — it cannot create transfers', async () => {
    process.env.STRIPE_RESTRICTED_KEY = 'rk_live_scopedkey';
    expect((await stripeConfig()).restrictedKey).toBe('rk_live_scopedkey');
  });

  it('rejects a secret key smuggled into the restricted-key variable', () => {
    process.env.STRIPE_RESTRICTED_KEY = 'sk_live_realkeyhere';
    expect(() => stripeConfig()).toThrow(/must be a restricted key/);
  });

  it('boots with no Stripe credential at all', async () => {
    expect(await stripeConfig()).toEqual({
      secretKey: undefined,
      restrictedKey: undefined,
      webhookSecretPlatform: undefined,
      webhookSecretConnect: undefined,
    });
  });
});

describe('IS_WORKER cannot be coerced into granting the key', () => {
  /**
   * THE regression. `validateConfig` transforms with `enableImplicitConversion`,
   * and class-transformer coerces a boolean-typed property with `Boolean(value)`
   * — so `'false'`, `'0'` and every other non-empty string became `true`.
   *
   * The constraint read that transformed value, so it answered "yes, this is the
   * worker" for `IS_WORKER=false`, which is exactly what `.env.example` ships for
   * the api process. A full Stripe secret key was therefore permitted on the
   * internet-reachable process that the whole isolation argument says must never
   * hold one.
   */
  it.each([
    ['false', 'the value .env.example ships for the api'],
    ['0', 'a falsy-looking value'],
    ['yes', 'an affirmative-looking value that is not the contract'],
    ['ture', 'a typo'],
    ['', 'an empty string'],
  ])('refuses a full secret key when IS_WORKER is %p (%s)', (value) => {
    process.env.IS_WORKER = value;
    process.env.STRIPE_SECRET_KEY = 'sk_live_deadbeef';
    expect(() => stripeConfig()).toThrow();
  });

  it('refuses when IS_WORKER is absent', () => {
    delete process.env.IS_WORKER;
    process.env.STRIPE_SECRET_KEY = 'sk_live_deadbeef';
    expect(() => stripeConfig()).toThrow();
  });

  it('still allows it on a real worker', () => {
    process.env.IS_WORKER = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_live_deadbeef';
    expect(() => stripeConfig()).not.toThrow();
  });
});
