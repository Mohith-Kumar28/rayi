import { ConfigService } from '@nestjs/config';

import type { GlobalConfig } from '@/config/config.type';
import type { PrismaService } from '@/database/prisma.service';

import {
  MailSendError,
  MailService,
  MailSuppressedError,
} from './mail.service';

/**
 * The send path.
 *
 * Resend is stubbed at the client boundary: what is under test is OUR handling
 * of it, and the two things most likely to be got wrong are both invisible in a
 * happy-path integration test.
 *
 *   1. `emails.send()` RESOLVES on failure, returning `{ data: null, error }`.
 *      A port from nodemailer, which throws, would see no exception and mark the
 *      job complete while the email was never sent.
 *   2. The idempotency key must be DERIVED from the intent. Generated per
 *      attempt, it would be fresh on every BullMQ retry and deduplicate nothing
 *      — which for a magic link means several live credentials in a mailbox.
 */

interface SendCall {
  payload: Record<string, unknown>;
  options?: { idempotencyKey?: string };
}

function makeService(options: {
  apiKey?: string;
  redirectAllTo?: string;
  replyTo?: string;
  result?: {
    data: { id: string } | null;
    error: { name: string; message: string } | null;
  };
  /** A suppression row that `findFirst` should return, or null for none. */
  suppression?: { reason: string } | null;
}): { service: MailService; calls: SendCall[]; suppressionQueries: unknown[] } {
  const calls: SendCall[] = [];

  const config = {
    get: (key: string) => {
      switch (key) {
        case 'mail.apiKey':
          return options.apiKey;
        case 'mail.fromEmail':
          return 'no-reply@rayi.test';
        case 'mail.fromName':
          return 'Rayi';
        case 'mail.replyTo':
          return options.replyTo;
        case 'mail.redirectAllTo':
          return options.redirectAllTo;
        default:
          return undefined;
      }
    },
  } as unknown as ConfigService<GlobalConfig>;

  const suppressionQueries: unknown[] = [];
  const prisma = {
    emailSuppression: {
      findFirst: (args: unknown) => {
        suppressionQueries.push(args);
        return Promise.resolve(options.suppression ?? null);
      },
    },
  } as unknown as PrismaService;

  const service = new MailService(config, prisma);

  if (options.apiKey) {
    // Replace the constructed client. The constructor decides WHETHER there is a
    // client (that logic is under test below); this replaces WHAT it talks to.
    (service as unknown as { client: unknown }).client = {
      emails: {
        send: (
          payload: Record<string, unknown>,
          opts?: { idempotencyKey?: string },
        ) => {
          calls.push({ payload, options: opts });
          return Promise.resolve(
            options.result ?? { data: { id: 'email_123' }, error: null },
          );
        },
      },
    };
  }

  return { service, calls, suppressionQueries };
}

describe('a process with no api key', () => {
  it('REFUSES to send rather than silently doing nothing', async () => {
    // The api process. A no-op here is how a creator never receives a payout
    // notification and nobody finds out.
    const { service } = makeService({});
    await expect(
      service.sendAuthMagicLinkMail({
        email: 'a@b.test',
        url: 'https://x.test/1',
      }),
    ).rejects.toThrow(MailSendError);
  });

  it('says which process should have sent it', async () => {
    const { service } = makeService({});
    await expect(
      service.sendAuthMagicLinkMail({
        email: 'a@b.test',
        url: 'https://x.test/1',
      }),
    ).rejects.toThrow(/WORKER/);
  });
});

describe('a successful send', () => {
  it('renders HTML and a plain-text alternative', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'jordan@acme.test',
      url: 'https://x.test/abc',
    });

    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload;

    expect(String(payload['html'])).toContain('Sign in to Rayi');
    expect(String(payload['html'])).toContain('jordan@acme.test');
    // A text/plain alternative measurably improves deliverability, and every
    // client that refuses HTML still gets something usable.
    expect(String(payload['text']).length).toBeGreaterThan(0);
    expect(String(payload['text'])).not.toContain('<');
  });

  it('puts the destination URL in the body, visibly', async () => {
    // A recipient who cannot see where a button goes has no way to tell a real
    // sign-in link from a lookalike domain.
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://app.rayi.test/go',
    });
    expect(String(calls[0]!.payload['html'])).toContain(
      'https://app.rayi.test/go',
    );
  });

  it('builds a from address with the display name', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendEmailVerificationMail({
      email: 'a@b.test',
      url: 'https://x.test/1',
    });
    expect(calls[0]!.payload['from']).toBe('Rayi <no-reply@rayi.test>');
  });

  it('omits replyTo entirely when unset, rather than sending an empty one', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendEmailVerificationMail({
      email: 'a@b.test',
      url: 'https://x.test/1',
    });
    expect('replyTo' in calls[0]!.payload).toBe(false);
  });

  it('includes replyTo when configured', async () => {
    const { service, calls } = makeService({
      apiKey: 're_test',
      replyTo: 'help@rayi.test',
    });
    await service.sendEmailVerificationMail({
      email: 'a@b.test',
      url: 'https://x.test/1',
    });
    expect(calls[0]!.payload['replyTo']).toBe('help@rayi.test');
  });

  it('never carries the recipient or the URL into a log line', async () => {
    // A magic link in a log is a credential in a log, readable by anyone with
    // log access and retained for as long as the log is.
    const logged: string[] = [];
    const { service } = makeService({ apiKey: 're_test' });
    (service as unknown as { logger: { log: (m: string) => void } }).logger = {
      log: (message: string) => logged.push(message),
    };

    await service.sendAuthMagicLinkMail({
      email: 'secret@person.test',
      url: 'https://app.rayi.test/magic?token=SECRET',
    });

    const all = logged.join('\n');
    expect(all).not.toContain('secret@person.test');
    expect(all).not.toContain('SECRET');
    expect(all).toContain('email_123');
  });
});

describe('a failed send', () => {
  it('THROWS, even though Resend resolved', async () => {
    // The single most likely way to get this integration wrong. Without this
    // branch the job is marked complete and the email never existed.
    const { service } = makeService({
      apiKey: 're_test',
      result: {
        data: null,
        error: { name: 'validation_error', message: 'Invalid `to` field' },
      },
    });

    await expect(
      service.sendAuthMagicLinkMail({ email: 'bad', url: 'https://x.test/1' }),
    ).rejects.toThrow(MailSendError);
  });

  it('names the template and the Resend error, so the failure is actionable', async () => {
    const { service } = makeService({
      apiKey: 're_test',
      result: {
        data: null,
        error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
      },
    });

    await expect(
      service.sendResetPasswordMail({
        email: 'a@b.test',
        url: 'https://x.test/1',
      }),
    ).rejects.toThrow(/reset-password.*rate_limit_exceeded.*Too many requests/);
  });

  it('lets the error escape so BullMQ retries', async () => {
    // Swallowing it would mark the job complete. An email nobody received and a
    // queue that says it succeeded is worse than a visible failure.
    const { service } = makeService({
      apiKey: 're_test',
      result: {
        data: null,
        error: { name: 'application_error', message: 'upstream' },
      },
    });
    await expect(
      service.sendEmailVerificationMail({
        email: 'a@b.test',
        url: 'https://x.test/1',
      }),
    ).rejects.toBeInstanceOf(MailSendError);
  });
});

describe('idempotency', () => {
  const key = (calls: SendCall[]) =>
    calls[calls.length - 1]?.options?.idempotencyKey;

  it('is identical for the same email sent twice', async () => {
    // BullMQ is at-least-once: a worker killed mid-send, a stalled job, or a
    // redelivery after a deploy all re-run the same job.
    const { service, calls } = makeService({ apiKey: 're_test' });
    const input = { email: 'a@b.test', url: 'https://x.test/token-1' };

    await service.sendAuthMagicLinkMail(input);
    const first = key(calls);
    await service.sendAuthMagicLinkMail(input);

    expect(key(calls)).toBe(first);
  });

  it('DIFFERS for a different link, so a genuine second email still sends', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://x.test/token-1',
    });
    const first = key(calls);
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://x.test/token-2',
    });
    expect(key(calls)).not.toBe(first);
  });

  it('differs for a different recipient', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://x.test/t',
    });
    const first = key(calls);
    await service.sendAuthMagicLinkMail({
      email: 'c@d.test',
      url: 'https://x.test/t',
    });
    expect(key(calls)).not.toBe(first);
  });

  it('differs for a different template with the same inputs', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://x.test/t',
    });
    const first = key(calls);
    await service.sendEmailVerificationMail({
      email: 'a@b.test',
      url: 'https://x.test/t',
    });
    expect(key(calls)).not.toBe(first);
  });

  it('does not leak the URL, which is a credential', async () => {
    // The key travels in a request header and is echoed in Resend's dashboard
    // and API responses.
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'a@b.test',
      url: 'https://app.rayi.test/magic?token=SUPERSECRET',
    });

    const value = key(calls)!;
    expect(value).not.toContain('SUPERSECRET');
    expect(value).not.toContain('a@b.test');
    expect(value).toMatch(/^rayi:signin-magic-link:[0-9a-f]{48}$/);
  });

  it('cannot be collided by moving a character between the fields', async () => {
    // Concatenating without a separator would make ('a@b.test', '/x') and
    // ('a@b.test/', 'x') hash identically — one user's link deduplicating
    // another's.
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({ email: 'a@b.test', url: '/x' });
    const first = key(calls);
    await service.sendAuthMagicLinkMail({ email: 'a@b.test/', url: 'x' });
    expect(key(calls)).not.toBe(first);
  });
});

describe('the staging redirect', () => {
  it('sends to the redirect address instead of the real recipient', async () => {
    // Sending a real magic link to a real brand's mailbox from staging is not a
    // mistake anyone gets to make twice.
    const { service, calls } = makeService({
      apiKey: 're_test',
      redirectAllTo: 'staging@rayi.test',
    });

    await service.sendAuthMagicLinkMail({
      email: 'real@brand.test',
      url: 'https://x.test/1',
    });

    expect(calls[0]!.payload['to']).toBe('staging@rayi.test');
  });

  it('records who it was really for, so the mailbox is readable', async () => {
    const { service, calls } = makeService({
      apiKey: 're_test',
      redirectAllTo: 'staging@rayi.test',
    });

    await service.sendAuthMagicLinkMail({
      email: 'real@brand.test',
      url: 'https://x.test/1',
    });

    expect(calls[0]!.payload['headers']).toEqual({
      'X-Rayi-Intended-Recipient': 'real@brand.test',
    });
  });

  it('adds no header at all when not redirecting', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'real@brand.test',
      url: 'https://x.test/1',
    });
    expect('headers' in calls[0]!.payload).toBe(false);
  });

  it('still addresses the body to the REAL recipient', async () => {
    // Otherwise a redirected email is useless for checking what a specific user
    // would have seen.
    const { service, calls } = makeService({
      apiKey: 're_test',
      redirectAllTo: 'staging@rayi.test',
    });
    await service.sendAuthMagicLinkMail({
      email: 'real@brand.test',
      url: 'https://x.test/1',
    });
    expect(String(calls[0]!.payload['html'])).toContain('real@brand.test');
  });
});

describe('the suppression list', () => {
  it('REFUSES to send to a hard-bounced address', async () => {
    // Continuing to send to a dead mailbox damages the sending domain's
    // reputation, which degrades delivery for every OTHER user. One dead address
    // quietly makes everyone else's sign-in links less likely to arrive.
    const { service, calls } = makeService({
      apiKey: 're_test',
      suppression: { reason: 'hard_bounce' },
    });

    await expect(
      service.sendAuthMagicLinkMail({
        email: 'dead@gone.test',
        url: 'https://x.test/1',
      }),
    ).rejects.toThrow(MailSuppressedError);

    // And nothing was sent.
    expect(calls).toHaveLength(0);
  });

  it('throws a DIFFERENT error from a send failure, because the remedy differs', async () => {
    // A send failure should be retried — BullMQ will, and should. A suppression
    // is terminal: retrying achieves nothing but further reputation damage.
    const { service } = makeService({
      apiKey: 're_test',
      suppression: { reason: 'complaint' },
    });

    const error = await service
      .sendAuthMagicLinkMail({ email: 'a@b.test', url: 'https://x.test/1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailSuppressedError);
    expect(error).not.toBeInstanceOf(MailSendError);
    expect((error as MailSuppressedError).reason).toBe('complaint');
  });

  it('checks BEFORE rendering, so a suppressed send costs nothing', async () => {
    const { service, suppressionQueries } = makeService({
      apiKey: 're_test',
      suppression: { reason: 'hard_bounce' },
    });

    await service
      .sendAuthMagicLinkMail({ email: 'a@b.test', url: 'https://x.test/1' })
      .catch(() => undefined);

    expect(suppressionQueries).toHaveLength(1);
  });

  it('looks up the LOWER-CASED address', async () => {
    // The unique index is on `lower(email)`. Querying the raw form would let
    // `A@b.com` slip past a suppression recorded for `a@b.com`.
    const { service, suppressionQueries } = makeService({ apiKey: 're_test' });

    await service.sendAuthMagicLinkMail({
      email: '  Jordan@ACME.test ',
      url: 'https://x.test/1',
    });

    expect(suppressionQueries[0]).toMatchObject({
      where: { email: 'jordan@acme.test', liftedAt: null },
    });
  });

  it('ignores a suppression that has been lifted', async () => {
    // A bounce can be a temporary mail-server misconfiguration, so suppression
    // must be reversible — and the query is what makes the lift take effect.
    const { service, calls, suppressionQueries } = makeService({
      apiKey: 're_test',
      suppression: null,
    });

    await service.sendAuthMagicLinkMail({
      email: 'recovered@b.test',
      url: 'https://x.test/1',
    });

    expect(suppressionQueries[0]).toMatchObject({ where: { liftedAt: null } });
    expect(calls).toHaveLength(1);
  });

  it('sends normally when the address is not suppressed', async () => {
    const { service, calls } = makeService({ apiKey: 're_test' });
    await service.sendAuthMagicLinkMail({
      email: 'fine@b.test',
      url: 'https://x.test/1',
    });
    expect(calls).toHaveLength(1);
  });
});
