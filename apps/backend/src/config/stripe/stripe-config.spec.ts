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
