import mailConfig, { getConfig } from './mail.config';

/**
 * The mail configuration, and the boundary that matters most in it.
 *
 * `RESEND_API_KEY` is worker-only for the same reason the Stripe secret key is:
 * the api process is internet-reachable, and a compromise there that could send
 * mail from our verified domain is a phishing capability aimed at the population
 * whose accounts receive money. A magic link is a credential, so "send email as
 * Rayi" is very close to "sign in as anyone".
 *
 * A comment saying so is not a control. A boot failure is — which is what these
 * tests assert.
 */

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env['RESEND_API_KEY'];
  delete process.env['IS_WORKER'];
  delete process.env['MAIL_REPLY_TO'];
  delete process.env['MAIL_REDIRECT_ALL_TO'];
  process.env['MAIL_FROM_EMAIL'] = 'no-reply@rayi.test';
  process.env['MAIL_FROM_NAME'] = 'Rayi';
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('the shape it produces', () => {
  it('reads the sender identity', () => {
    const config = getConfig();
    expect(config.fromEmail).toBe('no-reply@rayi.test');
    expect(config.fromName).toBe('Rayi');
  });

  it('leaves the api process with NO api key, rather than an empty string', () => {
    // `undefined` is what MailService checks to decide it cannot send. An empty
    // string would construct a Resend client with a blank key, which fails at
    // the API with an authentication error instead of at the call site with an
    // explanation.
    expect(getConfig().apiKey).toBeUndefined();
  });

  it('carries the key on the worker', () => {
    process.env['IS_WORKER'] = 'true';
    process.env['RESEND_API_KEY'] = 're_test_key';
    expect(getConfig().apiKey).toBe('re_test_key');
  });

  it('omits replyTo and redirectAllTo when unset rather than setting them empty', () => {
    const config = getConfig();
    expect('replyTo' in config).toBe(false);
    expect('redirectAllTo' in config).toBe(false);
  });

  it('carries the staging redirect when set', () => {
    process.env['MAIL_REDIRECT_ALL_TO'] = 'staging@rayi.test';
    expect(getConfig().redirectAllTo).toBe('staging@rayi.test');
  });
});

describe('the Resend key is worker-only', () => {
  it('REFUSES to boot the api with a Resend key present', () => {
    process.env['RESEND_API_KEY'] = 're_live_something';
    // IS_WORKER unset — this is the api process.
    expect(() => mailConfig()).toThrow();
  });

  it('refuses when IS_WORKER is explicitly false', () => {
    process.env['IS_WORKER'] = 'false';
    process.env['RESEND_API_KEY'] = 're_live_something';
    expect(() => mailConfig()).toThrow();
  });

  it('explains WHY in the failure, so nobody deletes the check to get past it', () => {
    process.env['RESEND_API_KEY'] = 're_live_something';
    try {
      mailConfig();
      throw new Error('expected a validation failure');
    } catch (error) {
      expect(String(error)).toMatch(/worker/i);
    }
  });

  it('allows the key on the worker', () => {
    process.env['IS_WORKER'] = 'true';
    process.env['RESEND_API_KEY'] = 're_live_something';
    expect(() => mailConfig()).not.toThrow();
  });

  it('allows any process to boot with no key at all', () => {
    // The api and webhooks processes are the normal case, and they must start.
    expect(() => mailConfig()).not.toThrow();
  });
});

describe('the sender identity is required', () => {
  it('refuses to boot without a from address', () => {
    delete process.env['MAIL_FROM_EMAIL'];
    // Not optional: a sender with no from address fails at Resend on the first
    // send, which is a password reset nobody receives rather than a boot error.
    expect(() => mailConfig()).toThrow();
  });

  it('refuses a from address that is not an email', () => {
    process.env['MAIL_FROM_EMAIL'] = 'rayi.test';
    expect(() => mailConfig()).toThrow();
  });

  it('refuses to boot without a from name', () => {
    delete process.env['MAIL_FROM_NAME'];
    expect(() => mailConfig()).toThrow();
  });

  it('refuses a reply-to that is not an email', () => {
    process.env['MAIL_REPLY_TO'] = 'not-an-address';
    expect(() => mailConfig()).toThrow();
  });

  it('refuses a staging redirect that is not an email', () => {
    // A typo here sends every magic link in staging to nowhere, silently.
    process.env['MAIL_REDIRECT_ALL_TO'] = 'oops';
    expect(() => mailConfig()).toThrow();
  });
});
