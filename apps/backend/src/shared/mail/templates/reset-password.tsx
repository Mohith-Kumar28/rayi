import { Text } from '@react-email/components';
import * as React from 'react';

import { Action, Layout } from './layout';

interface ResetPasswordProps {
  email: string;
  url: string;
}

/**
 * Kept, but currently unreachable: `emailAndPassword` is disabled and the
 * password endpoints are excluded from the Better Auth allowlist, so nothing
 * triggers this today.
 *
 * It stays rather than being deleted because the wiring behind it is correct and
 * re-enabling passwords should be a deliberate config change, not a hurried
 * reimplementation of a security-sensitive email during an incident.
 */
export function ResetPassword({ email, url }: ResetPasswordProps) {
  return (
    <Layout preview="Reset your Rayi password">
      <Text className="text-[20px] leading-[28px] font-semibold tracking-tight text-[#191919] m-0 mb-3">
        Reset your password
      </Text>
      <Text className="text-[14px] leading-[22px] text-[#454545] m-0">
        Someone asked to reset the password for <strong>{email}</strong>. The link below expires
        shortly and can be used once.
      </Text>

      <Action href={url} label="Reset password" />

      <Text className="text-[13px] leading-[20px] text-[#454545] mt-7 mb-0">
        If this was not you, your password has not changed and no further action is needed. If you
        get these repeatedly, tell us — it usually means someone is guessing at your address.
      </Text>
    </Layout>
  );
}

ResetPassword.PreviewProps = {
  email: 'jordan@acme.com',
  url: 'https://app.rayi.com/auth/reset?token=preview-token-not-real',
} satisfies ResetPasswordProps;

export default ResetPassword;
