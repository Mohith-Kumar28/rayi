import { Text } from '@react-email/components';
import * as React from 'react';

import { Action, Layout } from './layout';

interface EmailChangeConfirmProps {
  email: string;
  url: string;
}

/**
 * Sent to the NEW address.
 *
 * Confirming here proves the address can actually receive mail, which is what
 * stops a typo locking someone out of their own account permanently — the new
 * address is where every future sign-in link goes.
 */
export function EmailChangeConfirm({ email, url }: EmailChangeConfirmProps) {
  return (
    <Layout preview="Confirm your new Rayi email address">
      <Text className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#191919] m-0 mb-3">
        Confirm your new address
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] m-0">
        Confirm that <strong>{email}</strong> should become the email on your Rayi account. Every
        sign-in link and payment notification will go here afterwards.
      </Text>

      <Action href={url} label="Confirm this address" />

      <Text className="text-[13px] leading-[20px] text-[#454545] mt-7 mb-0">
        You will be signed out everywhere once this takes effect, so sign in again with your new
        address. If you did not ask for this, ignore it — nothing changes until you follow the link.
      </Text>
    </Layout>
  );
}

EmailChangeConfirm.PreviewProps = {
  email: 'jordan@newcompany.com',
  url: 'https://app.rayi.com/auth/email-change/confirm?token=preview-not-real',
} satisfies EmailChangeConfirmProps;

export default EmailChangeConfirm;
