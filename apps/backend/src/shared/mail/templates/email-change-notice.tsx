import { Text } from '@react-email/components';
import * as React from 'react';

import { Action, Layout } from './layout';

interface EmailChangeNoticeProps {
  email: string;
  newEmail: string;
  cancelUrl: string;
}

/**
 * Sent to the address being moved AWAY from.
 *
 * Whoever holds this address today is the person who needs to hear about the
 * change while there is still time to object — and the button is what makes this
 * a control rather than a courtesy. A notification that only says "this
 * happened" leaves the real owner watching their account being taken with
 * nothing to press.
 */
export function EmailChangeNotice({ email, newEmail, cancelUrl }: EmailChangeNoticeProps) {
  return (
    <Layout preview="Someone asked to change the email on your Rayi account">
      <Text className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#191919] m-0 mb-3">
        Someone asked to move your account
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] m-0">
        A request was made to change the email on the Rayi account for <strong>{email}</strong> to{' '}
        <strong>{newEmail}</strong>. It has not happened yet — it needs to be confirmed at the new
        address first.
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] mt-4 mb-0">
        <strong>If this was not you, stop it now.</strong> Whoever made the request could otherwise
        receive every future sign-in link for this account.
      </Text>

      <Action href={cancelUrl} label="Stop this change" />

      <Text className="text-[13px] leading-[20px] text-[#454545] mt-7 mb-0">
        If it was you, you can ignore this — just follow the confirmation link sent to the new
        address.
      </Text>
    </Layout>
  );
}

EmailChangeNotice.PreviewProps = {
  email: 'jordan@acme.com',
  newEmail: 'jordan@newcompany.com',
  cancelUrl: 'https://app.rayi.com/auth/email-change/cancel?token=preview-not-real',
} satisfies EmailChangeNoticeProps;

export default EmailChangeNotice;
