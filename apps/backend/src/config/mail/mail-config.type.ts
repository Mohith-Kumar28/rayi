export type MailConfig = {
  /**
   * The Resend API key. Present only on the worker — see mail.config.ts for why.
   * Undefined in the api and webhooks processes, and `MailService` refuses to
   * send rather than pretending it did.
   */
  apiKey?: string;
  /** The verified sending address. `"Rayi <no-reply@rayi.com>"` is built from this and fromName. */
  fromEmail: string;
  fromName: string;
  /** Where a human reply goes. Not the sending address, which is unattended. */
  replyTo?: string;
  /**
   * When set, every outbound email is redirected here and the real recipient is
   * recorded in a header. For staging, where sending a real magic link to a real
   * brand's mailbox is not a mistake anyone gets to make twice.
   */
  redirectAllTo?: string;
  /**
   * The Svix signing secret for Resend's webhooks (`whsec_...`).
   *
   * Held by whichever process serves the webhook route — the api today, its own
   * `webhooks` process once that exists. It is a VERIFICATION secret, not a
   * sending credential: it cannot send mail, so it does not carry the same
   * worker-only restriction as RESEND_API_KEY.
   */
  webhookSecret?: string;
};
