/**
 * The Resend webhook events we act on, and what each one means for us.
 *
 * Deliberately a closed set. An event type absent here is marked `ignored`
 * rather than `failed`: not handling `email.opened` is a decision, not a fault,
 * and burying real failures under noise is how a failure count stops being read.
 */

export const ResendEvent = {
  Sent: 'email.sent',
  Delivered: 'email.delivered',
  DeliveryDelayed: 'email.delivery_delayed',
  /** The mailbox does not exist, or the domain refused permanently. */
  Bounced: 'email.bounced',
  /** The recipient pressed "this is spam". */
  Complained: 'email.complained',
} as const;

export type ResendEvent = (typeof ResendEvent)[keyof typeof ResendEvent];

/** Why an address was suppressed. Matches the CHECK constraint on the column. */
export const SuppressionReason = {
  HardBounce: 'hard_bounce',
  Complaint: 'complaint',
  Manual: 'manual',
} as const;

export type SuppressionReason =
  (typeof SuppressionReason)[keyof typeof SuppressionReason];

/**
 * The shape we read out of a Resend payload.
 *
 * Only the fields we use, and every one optional, because this is untrusted
 * input from a third party whose payload shape can change in a release we did
 * not choose. A parser that assumes a field exists turns a provider's additive
 * change into our 500.
 */
export interface ResendPayload {
  readonly type?: string;
  readonly created_at?: string;
  readonly data?: {
    readonly email_id?: string;
    readonly to?: string[] | string;
    readonly subject?: string;
    readonly bounce?: {
      /** `Permanent` | `Transient` | `Undetermined` */
      readonly type?: string;
      readonly subType?: string;
      readonly message?: string;
    };
  };
}

/**
 * Whether a bounce is permanent.
 *
 * **Only a permanent bounce suppresses.** A transient one is a full mailbox, a
 * greylist, a temporarily unreachable server — all of which resolve on their
 * own. Suppressing on those would lock a creator out of their own account over a
 * mail server that was busy for an hour, and they would have no way to tell us,
 * because the way they tell us is email.
 *
 * Unknown values are treated as NOT permanent. The cost of being wrong in that
 * direction is one more email to a dead address; the cost the other way is a
 * user permanently unable to sign in.
 */
export function isPermanentBounce(payload: ResendPayload): boolean {
  return payload.data?.bounce?.type?.toLowerCase() === 'permanent';
}

/**
 * The recipients an event concerns.
 *
 * `to` arrives as a string or an array depending on how the mail was sent.
 * Normalised and lower-cased, because the suppression index is on
 * `lower(email)` and a mixed-case address must not slip past an existing entry.
 */
export function recipientsOf(payload: ResendPayload): string[] {
  const to = payload.data?.to;
  const list = typeof to === 'string' ? [to] : Array.isArray(to) ? to : [];
  return list
    .filter((address): address is string => typeof address === 'string')
    .map((address) => address.trim().toLowerCase())
    .filter((address) => address.length > 0);
}
