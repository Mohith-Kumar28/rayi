import { Text } from '@react-email/components';
import * as React from 'react';

import { Action, Layout } from './layout';

interface EmailVerificationProps {
  email: string;
  url: string;
}

export function EmailVerification({ email, url }: EmailVerificationProps) {
  return (
    <Layout preview="Confirm your email address">
      <Text className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#191919] m-0 mb-3">
        Confirm your email
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] m-0">
        Confirm that <strong>{email}</strong> is yours. This is the address every sign-in link and
        payment notification will be sent to, so it is worth getting right.
      </Text>

      <Action href={url} label="Confirm email" />

      <Text className="text-[13px] leading-[20px] text-[#454545] mt-7 mb-0">
        If you did not create a Rayi account, you can ignore this — the address will not be used.
      </Text>
    </Layout>
  );
}

EmailVerification.PreviewProps = {
  email: 'jordan@acme.com',
  url: 'https://app.rayi.com/auth/verify?token=preview-token-not-real',
} satisfies EmailVerificationProps;

export default EmailVerification;
