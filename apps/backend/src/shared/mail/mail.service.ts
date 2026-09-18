import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { render } from '@react-email/render';
import { createHash } from 'node:crypto';
import type { ReactElement } from 'react';
import { Resend } from 'resend';

import type { GlobalConfig } from '@/config/config.type';
import { PrismaService } from '@/database/prisma.service';

import EmailChangeConfirm from './templates/email-change-confirm';
import EmailChangeNotice from './templates/email-change-notice';
import EmailVerification from './templates/email-verification';
import ResetPassword from './templates/reset-password';
import SignInMagicLink from './templates/signin-magic-link';

/**
 * Transactional email, through Resend.
 *
 * Three things here are load-bearing, and each replaces something the previous
 * nodemailer + handlebars pipeline got wrong or could not do at all.
 *
 * **1. Resend does not throw on failure.** `emails.send()` resolves to
 * `{ data, error }`. A direct port from nodemailer — which throws — would
 * `await` the call, see no exception, and silently drop every email while every
 * log line said success. This is the single most likely way to get this
 * integration wrong, so it is handled once, here, and nowhere else.
 *
 * **2. Idempotency, derived from the intent.** The email queue is BullMQ, which
 * is at-least-once by design: a worker killed mid-send, a stalled job, or a
 * redelivery after a deploy all re-run the same job. For a magic link that means
 * several valid sign-in links in a mailbox, each one a credential, each with its
 * own expiry. Resend's `idempotencyKey` collapses those into one send — but only
 * if the key is DERIVED from what the email is about rather than generated per
 * attempt, which would make every retry a fresh key and defeat the whole thing.
 *
 * **3. The URL never reaches a log.** A magic link in a log line is a credential
 * in a log line, readable by anyone with log access and retained as long as the
 * log is. Nothing in this file logs a template context.
 *
 * Templates are React Email components rendered at send time. The previous
 * pipeline compiled `.tsx` to `.hbs` at build time and interpolated `{{email}}`
 * placeholders at runtime — two representations of one template, a build step
 * between them, and a `strict: true` handlebars option as the only thing
 * standing between a renamed prop and an email that says `{{url}}` to a user.
 */

/** What a caller may ask to be sent. Closed, so a typo is a type error. */
type TemplateName =
  | 'email-verification'
  | 'signin-magic-link'
  | 'reset-password'
  | 'email-change-confirm'
  | 'email-change-notice';

interface TemplateContext {
  readonly email: string;
  readonly url: string;
  /** Only the email-change notice uses this; the others ignore it. */
  readonly newEmail?: string;
}

const TEMPLATES: Record<
  TemplateName,
  { subject: string; component: (props: TemplateContext) => ReactElement }
> = {
  'email-verification': {
    subject: 'Verify your email',
    component: EmailVerification,
  },
  'signin-magic-link': {
    subject: 'Your sign-in link',
    component: SignInMagicLink,
  },
  'reset-password': {
    subject: 'Reset your password',
    component: ResetPassword,
  },
  'email-change-confirm': {
    subject: 'Confirm your new email address',
    component: EmailChangeConfirm,
  },
  'email-change-notice': {
    // Deliberately alarming. This is the only message that asks someone to ACT,
    // and it competes for attention with everything else in their inbox.
    subject: 'Action needed: someone asked to change your Rayi email',
    component: (props) =>
      EmailChangeNotice({
        email: props.email,
        newEmail: props.newEmail ?? '',
        cancelUrl: props.url,
      }),
  },
};

/**
 * Raised when an address is on the suppression list.
 *
 * Distinct from `MailSendError` on purpose. A send failure should be RETRIED —
 * BullMQ will, and should. A suppression is terminal: the mailbox does not
 * exist, or its owner marked us as spam, and retrying achieves nothing except
 * further damage to the sending domain's reputation.
 *
 * It also needs a different answer at the UI. "We could not reach that address"
 * is actionable; "something went wrong" is not, and silently succeeding is the
 * worst of the three.
 */
export class MailSuppressedError extends Error {
  constructor(
    readonly email: string,
    readonly reason: string,
  ) {
    super(`Refusing to send: ${email} is suppressed (${reason}).`);
    this.name = 'MailSuppressedError';
  }
}

export class MailSendError extends Error {
  constructor(
    message: string,
    readonly template: TemplateName,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly client: Resend | undefined;

  constructor(
    private readonly config: ConfigService<GlobalConfig>,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get('mail.apiKey', { infer: true });
    // Constructed only where a key exists, which is the worker. In the api this
    // stays undefined and `send` refuses — the api enqueues, it never sends.
    this.client = apiKey ? new Resend(apiKey) : undefined;
  }

  async sendEmailVerificationMail(input: TemplateContext): Promise<void> {
    await this.send('email-verification', input);
  }

  async sendAuthMagicLinkMail(input: TemplateContext): Promise<void> {
    await this.send('signin-magic-link', input);
  }

  async sendResetPasswordMail(input: TemplateContext): Promise<void> {
    await this.send('reset-password', input);
  }

  async sendEmailChangeConfirmMail(input: {
    email: string;
    url: string;
  }): Promise<void> {
    await this.send('email-change-confirm', input);
  }

  /**
   * To the OLD address, with the link that stops the change.
   *
   * Sent even if the old address is SUPPRESSED would be wrong — a suppressed
   * address cannot receive anything — but the suppression check lives in `send`
   * and raises, which is correct: a change whose warning could not be delivered
   * is one the real owner never got the chance to stop, and that is worth a
   * visible failure rather than a silent one.
   */
  async sendEmailChangeNoticeMail(input: {
    email: string;
    newEmail: string;
    cancelUrl: string;
  }): Promise<void> {
    await this.send('email-change-notice', {
      email: input.email,
      url: input.cancelUrl,
      newEmail: input.newEmail,
    });
  }

  private async send(
    template: TemplateName,
    context: TemplateContext,
  ): Promise<void> {
    if (!this.client) {
      // Deliberately an error, not a silent no-op. A process that cannot send
      // mail but reports that it did is how a creator never receives a payout
      // notification and nobody finds out.
      throw new MailSendError(
        'No Resend API key in this process, so it cannot send mail. Email is sent by the ' +
          'WORKER; the api enqueues a job. If this fired in the worker, RESEND_API_KEY is unset.',
        template,
      );
    }

    // SUPPRESSION, before anything is rendered or sent.
    //
    // A hard-bounced address is a mailbox that does not exist; a complaint is
    // someone who marked us as spam. Continuing to send to either damages the
    // sending domain's reputation, which degrades delivery for EVERY other user
    // — so one dead address quietly makes everyone else's sign-in links less
    // likely to arrive.
    //
    // Checked against `lower(email)` because that is what the unique index is
    // on; comparing the raw form would let `A@b.com` slip past a suppression on
    // `a@b.com`.
    const suppression = await this.prisma.emailSuppression.findFirst({
      where: { email: context.email.trim().toLowerCase(), liftedAt: null },
      select: { reason: true },
    });

    if (suppression) {
      throw new MailSuppressedError(context.email, suppression.reason);
    }

    const { subject, component } = TEMPLATES[template];
    const html = await render(component(context));
    // Every client that refuses HTML still gets something useful, and a
    // text/plain alternative measurably improves deliverability.
    const text = await render(component(context), { plainText: true });

    const redirectTo = this.config.get('mail.redirectAllTo', { infer: true });
    const recipient = redirectTo ?? context.email;
    const replyTo = this.config.get('mail.replyTo', { infer: true });

    const { data, error } = await this.client.emails.send(
      {
        from: `${this.config.get('mail.fromName', { infer: true })} <${this.config.get(
          'mail.fromEmail',
          { infer: true },
        )}>`,
        to: recipient,
        subject,
        html,
        text,
        ...(replyTo ? { replyTo } : {}),
        // A staging send says who it was really for, so a redirected mailbox is
        // readable rather than an undifferentiated pile.
        ...(redirectTo
          ? { headers: { 'X-Rayi-Intended-Recipient': context.email } }
          : {}),
      },
      { idempotencyKey: this.idempotencyKey(template, context) },
    );

    if (error) {
      // THE trap. Resend resolves rather than throwing, so without this branch a
      // failed send is indistinguishable from a successful one — and the job
      // would be marked complete.
      throw new MailSendError(
        `Resend refused ${template}: ${error.name} — ${error.message}`,
        template,
        error,
      );
    }

    // The id, never the recipient and never the URL.
    this.logger.log(`Sent ${template} (resend id ${data?.id ?? 'unknown'}).`);
  }

  /**
   * A key derived from WHAT is being sent, not from this attempt.
   *
   * The URL is hashed rather than included: an idempotency key travels in a
   * request header and is echoed back in Resend's dashboard and API responses,
   * and a magic link is a credential. Hashing keeps the key stable across
   * retries while making it useless to anyone who reads it.
   *
   * Two different links therefore produce two different keys and both send,
   * which is correct — they are different intents. The same link retried
   * produces the same key and sends once, which is the case BullMQ's
   * at-least-once delivery creates.
   *
   * The separator is a character that cannot appear in an email address or a
   * URL, so `a@b.com` + `/x` cannot collide with `a@b.com/` + `x`.
   */
  private idempotencyKey(
    template: TemplateName,
    context: TemplateContext,
  ): string {
    const digest = createHash('sha256')
      .update([template, context.email, context.url].join(''))
      .digest('hex');
    return `rayi:${template}:${digest.slice(0, 48)}`;
  }
}
